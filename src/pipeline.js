// Pipeline orchestrator. Two entry points:
//   runEpisode({ url, dryRun })   — for --episode flag, single video
//   runDaily({ dryRun, lookbackDays }) — full daily run
//
// Both wrap each stage with timing logs and accumulate Claude cost in the
// runs table, so we can see end-of-run "$X total" telemetry.

import { startRun, endRun, getEpisode, db } from './lib/db.js';
import { ingestEpisode, ingestDaily } from './stages/1-ingest.js';
import { transcribeEpisode } from './stages/2-transcribe.js';
import { extractEpisode } from './stages/3-extract.js';
import { rankEpisode } from './stages/4-rank.js';
import { composeBrief } from './stages/5-compose.js';
import { deliver } from './stages/6-deliver.js';
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

  await stage(`extract ${episode.video_id}`,    () => extractEpisode(episode, { run_id }));
  await stage(`rank ${episode.video_id}`,       () => rankEpisode(episode,    { run_id }));
  return true;
}

export async function runEpisode({ url, dryRun }) {
  const mode = dryRun ? 'dry-run-episode' : 'episode';
  const run_id = startRun(mode);
  let processed = 0, ok = false, briefResult = null;
  try {
    const [ep] = await stage('ingest', () => ingestEpisode(url));
    const ready = await processEpisode(ep, run_id);
    const episodes = ready ? [getEpisode(ep.video_id)] : [];
    processed = episodes.length;

    const html = await stage('compose', () => composeBrief(episodes));
    briefResult = await stage('deliver', () =>
      deliver(html, { dryRun, episodes, date: new Date() })
    );
    ok = true;
  } finally {
    const usd = totalCostForRun(run_id);
    endRun(run_id, { ok, episodes_processed: processed, total_usd: usd });
    log.ok('run complete', { run_id, processed, total_usd: usd.toFixed(4) });
  }
  return briefResult;
}

export async function runDaily({ dryRun, lookbackDays = 2 } = {}) {
  const mode = dryRun ? 'dry-run-daily' : 'daily';
  const run_id = startRun(mode);
  let processed = 0, ok = false, briefResult = null;
  try {
    await stage('ingest', () => ingestDaily({ lookbackDays }));

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
