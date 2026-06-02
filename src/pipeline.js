// Pipeline orchestrator. Two entry points:
//   runEpisode({ url, dryRun })   — for --episode flag, single video
//   runDaily({ dryRun, lookbackDays }) — full daily run
//
// Both wrap each stage with timing logs and accumulate Claude cost in the
// runs table, so we can see end-of-run "$X total" telemetry.

import { startRun, endRun, getEpisode, setEpisodeStatus, db } from './lib/db.js';
import { ingestEpisode, ingestDaily, ingestPodcastsDaily } from './stages/1-ingest.js';
import { discoverIndividuals } from './stages/1b-discover.js';
import { transcribeEpisode } from './stages/2-transcribe.js';
import { extractEpisode } from './stages/3-extract.js';
import { rankEpisode } from './stages/4-rank.js';
import { composeBrief } from './stages/5-compose.js';
import { deliver } from './stages/6-deliver.js';
import { backupDatabase } from './lib/backup.js';
import { log, stage } from './lib/log.js';

// Statuses that mean "ingested but not finished" — these get picked back up
// on subsequent runs for idempotent resume.
const RESUMABLE = ['new', 'transcribed', 'extracted', 'ranked'];

function totalCostForRun(run_id) {
  const row = db()
    .prepare(`SELECT COALESCE(SUM(usd_cost), 0) AS total FROM cost_ledger WHERE run_id = ?`)
    .get(run_id);
  return row.total || 0;
}

function resumableEpisodes() {
  const placeholders = RESUMABLE.map(() => '?').join(',');
  return db()
    .prepare(`SELECT * FROM episodes WHERE status IN (${placeholders}) ORDER BY published_at DESC`)
    .all(...RESUMABLE);
}

// Walk a single episode through transcribe → extract → rank. Returns true if
// it made it to a ranked state (i.e., is eligible for the brief).
async function processEpisode(episode, run_id) {
  if (episode.status === 'delivered') {
    log.info('already delivered, skipping', { video_id: episode.video_id });
    return false;
  }
  if (episode.status === 'skipped') {
    log.info('previously skipped, not retrying', { video_id: episode.video_id, reason: episode.skip_reason });
    return false;
  }

  const transcript = await stage(`transcribe ${episode.video_id}`, () => transcribeEpisode(episode));
  if (!transcript) return false; // skipped (no captions + no Groq, or oversize)

  // Skip extract if candidates already exist — extraction is profile-independent
  // and deterministic-ish, so re-running just burns tokens. Rank is cheap and
  // profile-dependent, so we always re-run it (lets profile.md edits propagate).
  if (episode.status === 'new' || episode.status === 'transcribed') {
    await stage(`extract ${episode.video_id}`, () => extractEpisode(episode, { run_id }));
  } else {
    log.info('extract cached, reusing candidates', { video_id: episode.video_id, status: episode.status });
  }
  await stage(`rank ${episode.video_id}`, () => rankEpisode(episode, { run_id }));
  return true;
}

// markDeliveredOnSend (default true): controls whether the episode is marked
// 'delivered' after sending. The web UI's ad-hoc URL flow passes false so the
// episode also rolls up into the next daily run alongside other content.
//
// forceReprocess (default false): ad-hoc semantics — the user explicitly asked
// to process THIS url now, so reset any prior 'skipped'/'delivered'/'ranked'
// status to 'new' after ingest, so processEpisode doesn't early-out. The daily
// cron path never sets this (it respects skip/delivered to avoid wasted work).
//
// Returns the deliver result augmented with the resolved video_id so callers
// (the web endpoint) don't have to re-derive it — necessary now that the id of
// a podcast episode isn't knowable from the pasted URL without resolving it.
export async function runEpisode({ url, dryRun, markDeliveredOnSend = true, forceReprocess = false }) {
  const mode = dryRun ? 'dry-run-episode' : 'episode';
  const run_id = startRun(mode);
  let processed = 0, ok = false, briefResult = null, video_id = null;
  try {
    let [ep] = await stage('ingest', () => ingestEpisode(url));
    video_id = ep.video_id;
    if (forceReprocess && ep.status !== 'new') {
      setEpisodeStatus(ep.video_id, 'new', null);
      ep = getEpisode(ep.video_id);
    }
    const ready = await processEpisode(ep, run_id);
    const episodes = ready ? [getEpisode(ep.video_id)] : [];
    processed = episodes.length;

    const html = await stage('compose', () => composeBrief(episodes));
    briefResult = await stage('deliver', () =>
      deliver(html, { dryRun, episodes, date: new Date(), markDeliveredOnSend })
    );
    ok = true;
  } finally {
    const usd = totalCostForRun(run_id);
    endRun(run_id, { ok, episodes_processed: processed, total_usd: usd });
    log.ok('run complete', { run_id, processed, total_usd: usd.toFixed(4) });
  }
  return { ...briefResult, video_id };
}

export async function runDaily({ dryRun, lookbackDays = 2 } = {}) {
  const mode = dryRun ? 'dry-run-daily' : 'daily';
  const run_id = startRun(mode);
  let processed = 0, ok = false, briefResult = null;
  try {
    // Snapshot the DB before any new writes for the day. Non-fatal: a failed
    // backup must not block the brief from going out. Email-attached weekly
    // off-site copy is gated inside backupDatabase by UTC day-of-week.
    await stage('backup', async () => {
      try { await backupDatabase({ emailIfDue: true }); }
      catch (err) { log.warn('backup failed (continuing)', { err: err.message }); }
    });

    await stage('ingest', () => ingestDaily({ lookbackDays }));
    // Podcast RSS ingest runs alongside YouTube channel polling. New podcast
    // rows (medium='podcast') flow through the same resumable loop below and are
    // transcribed by the Modal WhisperX worker via the medium-aware stage 2.
    // Non-fatal: a feed-parsing failure must not block the YouTube brief.
    await stage('ingest-podcasts', async () => {
      try { await ingestPodcastsDaily({ lookbackDays }); }
      catch (err) { log.warn('podcast ingest failed (continuing)', { err: err.message }); }
    });
    // Discovery: searches YouTube for watched individuals and promotes
    // LLM-approved finds into episodes (status='new'). Skipped silently if
    // disabled in config or no individuals are listed.
    await discoverIndividuals({ run_id });

    // Pick up everything ingested-but-not-finished (handles resume of prior partials).
    const pending = resumableEpisodes();
    log.info(`processing ${pending.length} pending episode(s)`);

    const ready = [];
    for (const ep of pending) {
      if (await processEpisode(ep, run_id)) {
        ready.push(getEpisode(ep.video_id));
        processed++;
      }
    }

    const html = await stage('compose', () => composeBrief(ready));
    briefResult = await stage('deliver', () =>
      deliver(html, { dryRun, episodes: ready, date: new Date() })
    );
    ok = true;
  } finally {
    const usd = totalCostForRun(run_id);
    endRun(run_id, { ok, episodes_processed: processed, total_usd: usd });
    log.ok('run complete', { run_id, processed, total_usd: usd.toFixed(4) });
  }
  return briefResult;
}
