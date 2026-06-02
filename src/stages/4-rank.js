// Stage 4: Rank candidates against the reader's interest profile.
//
// The profile is part of the system block (cached) — same profile across
// every episode in the run, so cache hits cover all rank calls after the first.

import { loadProfile, loadPrompt } from '../lib/config.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import { getCandidates, saveRankings, setEpisodeStatus } from '../lib/db.js';
import { validateCorrectedQuote } from '../lib/number-check.js';
import { log } from '../lib/log.js';

const SYSTEM = `${loadPrompt('rank')}\n\n--- READER INTEREST PROFILE ---\n\n${loadProfile()}`;

// A/B knob: RANK_MODEL=opus runs the synthesis pass (selection + why_matters +
// quote correction) on Opus instead of Sonnet. Defaults to Sonnet.
const RANK_MODEL = process.env.RANK_MODEL === 'opus' ? MODELS.OPUS : MODELS.SONNET;
// QUOTE_CORRECTION=off keeps the model's corrected quotes out of the brief
// (raw supporting_quote is shown). Defaults on. Lets you A/B the feature itself
// independent of the model knob.
const QUOTE_CORRECTION = process.env.QUOTE_CORRECTION !== 'off';

// Pull the model's proposed corrected quote for a given candidate id out of a
// ranking entry — `corrected_quotes` map (bundle) takes precedence, else the
// single `corrected_quote`. JSON object keys are strings; ids are numbers.
function proposedCorrection(r, id) {
  const map = r.corrected_quotes;
  if (map && typeof map === 'object') return map[id] ?? map[String(id)] ?? null;
  if (typeof r.corrected_quote === 'string') return r.corrected_quote;
  return null;
}

export async function rankEpisode(episode, { run_id }) {
  const candidates = getCandidates(episode.video_id);
  if (candidates.length === 0) {
    log.warn('no candidates to rank', { video_id: episode.video_id });
    return [];
  }

  const userMsg = [
    `Episode: ${episode.title}`,
    `Channel: ${episode.channel_name}`,
    `Published: ${episode.published_at}`,
    '',
    '--- CANDIDATES ---',
    JSON.stringify(
      candidates.map(c => ({
        id:               c.id,
        timestamp_sec:    c.timestamp_sec,
        speaker:          c.speaker,
        claim:            c.claim,
        category:         c.category,
        novelty_score:    c.novelty_score,
        supporting_quote: c.supporting_quote,
      })),
      null, 2,
    ),
  ].join('\n');

  const { text } = await complete({
    model: RANK_MODEL,
    system: SYSTEM,
    max_tokens: 4096,   // headroom for per-item corrected quotes on top of why_matters
    messages: [{ role: 'user', content: userMsg }],
    telemetry: { run_id, video_id: episode.video_id, stage: 'rank' },
  });

  let rankings;
  try {
    rankings = parseJsonResponse(text);
  } catch (err) {
    log.error('rank: JSON parse failed', { video_id: episode.video_id, err: err.message });
    return [];
  }
  if (!Array.isArray(rankings)) {
    log.error('rank: response was not an array', { video_id: episode.video_id });
    return [];
  }

  // Validate ids for both shapes (single: candidate_id; bundle:
  // candidate_ids[]). Bundles with any unknown ids keep only the known ones;
  // a bundle reduced to fewer than 2 valid ids gets demoted to a single.
  const validIds = new Set(candidates.map(c => c.id));
  rankings = rankings
    .map(r => {
      if (Array.isArray(r.candidate_ids) && r.candidate_ids.length) {
        const filtered = r.candidate_ids.filter(id => validIds.has(id));
        if (filtered.length === 0) return null;
        if (filtered.length === 1) {
          const { candidate_ids, label, ...rest } = r;
          return { ...rest, candidate_id: filtered[0] };
        }
        return { ...r, candidate_ids: filtered };
      }
      return validIds.has(r.candidate_id) ? r : null;
    })
    .filter(Boolean);

  // Validate the model's proposed quote corrections against each candidate's
  // RAW supporting_quote. The raw quote is never mutated — it stays the audit
  // trail + number-fidelity input; we only attach a vetted display copy. Any
  // correction that invents a numeral, drops a claim number, or rewrites too
  // much is rejected → compose falls back to the raw quote.
  const byId = new Map(candidates.map(c => [c.id, c]));
  let applied = 0, rejected = 0;
  for (const r of rankings) {
    const ids = Array.isArray(r.candidate_ids) && r.candidate_ids.length
      ? r.candidate_ids : [r.candidate_id];
    const dq = {};
    for (const id of ids) {
      const cand = byId.get(id);
      if (!cand) continue;
      const proposed = QUOTE_CORRECTION ? proposedCorrection(r, id) : null;
      const valid = proposed
        ? validateCorrectedQuote({ raw: cand.supporting_quote, corrected: proposed, claim: cand.claim })
        : null;
      dq[id] = valid;
      if (proposed) (valid ? applied++ : rejected++);
    }
    r.display_quotes = dq;
  }

  const bundleCount = rankings.filter(r => Array.isArray(r.candidate_ids)).length;
  saveRankings(episode.video_id, rankings);
  setEpisodeStatus(episode.video_id, 'ranked');
  log.ok('ranked', {
    video_id: episode.video_id, picked: rankings.length, bundles: bundleCount,
    model: RANK_MODEL, quotes_corrected: applied, quotes_rejected: rejected,
  });
  return rankings;
}
