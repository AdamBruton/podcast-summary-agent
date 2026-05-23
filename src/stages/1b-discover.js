// Stage 1b: Discovery.
//
// For each individual in sources.yaml individuals: list, search YouTube via
// yt-dlp, apply mechanical filters, then do a single Claude curation call
// across all surviving candidates. Approvals get promoted into the episodes
// table (status='new', source='discovery') so downstream stages pick them up
// just like any subscribed-channel ingest.
//
// Standalone via `npm run discover` (no auto-promote); also called by
// runDaily() after ingestDaily() when config.discovery.enabled.

import { loadSources, loadProfile, loadPrompt } from '../lib/config.js';
import { searchAndFilter } from '../lib/discovery-search.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import {
  saveDiscovery, markDiscoveryPromoted, upsertEpisode,
} from '../lib/db.js';
import { fetchMetadata } from '../lib/youtube.js';
import { log, stage } from '../lib/log.js';

// Defaults applied if config/sources.yaml doesn't override.
const DEFAULTS = {
  enabled:          true,
  lookback_days:    7,
  min_duration_sec: 20 * 60,   // 20 minutes
  results_per_name: 20,
};

function resolveOpts(discoveryConfig) {
  return { ...DEFAULTS, ...(discoveryConfig || {}) };
}

// Public entry point. opts:
//   - run_id     : for cost telemetry (optional)
//   - promote    : if true (default), approvals get inserted into episodes.
//                  If false, the function only persists to discoveries (for
//                  safe testing via `npm run discover`).
//   - names      : optional override array; if absent uses sources.yaml individuals.
//   - resultsPerName: optional override
export async function discoverIndividuals({ run_id = null, promote = true, names = null, resultsPerName = null } = {}) {
  return stage('discover', async () => {
    const sources = loadSources();
    const cfg = resolveOpts(sources.discovery);
    if (!cfg.enabled && !names) {
      log.info('discovery disabled in config; skipping');
      return { searched: 0, kept: 0, dropped: 0, approved: 0, rejected: 0, promoted: 0 };
    }
    const namesToSearch = names || sources.individuals || [];
    if (namesToSearch.length === 0) {
      log.info('no individuals configured for discovery');
      return { searched: 0, kept: 0, dropped: 0, approved: 0, rejected: 0, promoted: 0 };
    }

    const subscribedIds = new Set(
      sources.channels.map(c => c.channel_id).filter(Boolean),
    );
    const opts = {
      lookbackDays:        cfg.lookback_days,
      minDurationSec:      cfg.min_duration_sec,
      subscribedChannelIds: subscribedIds,
      resultsPerName:       resultsPerName || cfg.results_per_name,
    };

    // 1) Search + mechanical filter per name.
    const allKept = [];
    let totalDropped = 0;
    for (const name of namesToSearch) {
      const { kept, dropped, raw } = await searchAndFilter(name, opts);
      log.info(`search "${name}"`, { raw: raw.length, kept: kept.length, dropped: dropped.length });
      // Persist mechanical drops too, so the audit shows what got filtered.
      for (const d of dropped) {
        saveDiscovery({
          video_id:        d.video.video_id,
          searched_for:    name,
          title:           d.video.title,
          channel_name:    d.video.channel_name,
          duration_sec:    d.video.duration_sec,
          upload_date:     d.video.upload_date,
          url:             d.video.url,
          decision:        'filtered',
          decision_reason: d.reason,
          promoted:        0,
        });
      }
      totalDropped += dropped.length;
      for (const k of kept) allKept.push({ ...k, searched_for: name });
    }

    if (allKept.length === 0) {
      log.ok('discover: no candidates survived mechanical filter', { dropped: totalDropped });
      return { searched: namesToSearch.length, kept: 0, dropped: totalDropped, approved: 0, rejected: 0, promoted: 0 };
    }

    // 2) LLM curation pass — single call, all surviving candidates at once.
    log.info(`curating ${allKept.length} candidates via Claude`);
    const decisions = await curate(allKept, { run_id });

    // 3) Persist all candidates with their decision; promote approved.
    let approved = 0, rejected = 0, promoted = 0;
    for (const cand of allKept) {
      const dec = decisions.get(cand.video_id) || { decision: 'reject', reason: 'no LLM response' };
      saveDiscovery({
        video_id:        cand.video_id,
        searched_for:    cand.searched_for,
        title:           cand.title,
        channel_name:    cand.channel_name,
        duration_sec:    cand.duration_sec,
        upload_date:     cand.upload_date,
        url:             cand.url,
        decision:        dec.decision,
        decision_reason: dec.reason,
        promoted:        0,
      });
      if (dec.decision === 'approve') approved++; else rejected++;

      if (dec.decision === 'approve' && promote) {
        // Fetch full metadata for the approved video and insert into episodes.
        // We also re-verify upload date here — yt-dlp's flat-playlist search
        // mode doesn't populate upload_date reliably, so the pre-filter
        // lookback check is best-effort. The full-metadata fetch always
        // gives us a definitive published_at.
        try {
          const meta = await fetchMetadata(cand.url);
          const cutoffMs = Date.now() - cfg.lookback_days * 86_400_000;
          const pubMs = meta.published_at ? Date.parse(meta.published_at) : null;
          if (Number.isFinite(pubMs) && pubMs < cutoffMs) {
            log.info(`approved but too old; not promoting`, {
              vid: cand.video_id, published: meta.published_at, lookback_days: cfg.lookback_days,
            });
            // Downgrade decision so the audit reflects the final outcome.
            saveDiscovery({
              video_id:        cand.video_id,
              searched_for:    cand.searched_for,
              title:           cand.title,
              channel_name:    cand.channel_name,
              duration_sec:    meta.duration_sec || cand.duration_sec,
              upload_date:     meta.published_at,
              url:             cand.url,
              decision:        'filtered',
              decision_reason: `LLM approved but published ${meta.published_at} (> ${cfg.lookback_days}d ago)`,
              promoted:        0,
            });
            approved--; rejected++;   // reclassify in the rolling counts
            continue;
          }
          upsertEpisode({
            ...meta,
            source:         'discovery',
            discovered_for: cand.searched_for,
          });
          markDiscoveryPromoted(cand.video_id);
          promoted++;
          log.ok(`promoted to episodes`, { vid: cand.video_id, searched: cand.searched_for });
        } catch (err) {
          log.warn(`promote failed (metadata fetch)`, { vid: cand.video_id, err: err.message });
        }
      }
    }

    log.ok('discover complete', {
      searched: namesToSearch.length,
      kept:     allKept.length,
      dropped:  totalDropped,
      approved, rejected, promoted,
    });
    return { searched: namesToSearch.length, kept: allKept.length, dropped: totalDropped, approved, rejected, promoted };
  });
}

async function curate(candidates, { run_id }) {
  const profile  = loadProfile();
  const prompt   = loadPrompt('discovery-curate');
  const system   = `${prompt}\n\n---\n\n# Reader's Interest Profile\n\n${profile}`;

  const inputForModel = candidates.map(c => ({
    video_id:     c.video_id,
    searched_for: c.searched_for,
    title:        c.title,
    channel_name: c.channel_name,
    duration_min: typeof c.duration_sec === 'number' ? Math.round(c.duration_sec / 60) : null,
    upload_date:  c.upload_date,
    url:          c.url,
  }));

  const userMsg = [
    `Candidates to curate (${candidates.length}):`,
    '```json',
    JSON.stringify(inputForModel, null, 2),
    '```',
    '',
    `Return one decision per candidate, in input order.`,
  ].join('\n');

  let parsed = [];
  try {
    const { text } = await complete({
      model: MODELS.SONNET,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: Math.max(2048, candidates.length * 60),
      telemetry: { run_id, stage: 'discovery-curate' },
    });
    parsed = parseJsonResponse(text);
    if (!Array.isArray(parsed)) throw new Error('response not an array');
  } catch (err) {
    log.warn('curation failed; defaulting all candidates to reject', { err: err.message });
  }

  const byId = new Map();
  for (const d of parsed) {
    if (d && d.video_id) {
      byId.set(d.video_id, {
        decision: d.decision === 'approve' ? 'approve' : 'reject',
        reason:   d.reason || null,
      });
    }
  }
  return byId;
}
