// Pipeline orchestrator. Two entry points:
//   runEpisode({ url, dryRun })   — for --episode flag, single video
//   runDaily({ dryRun, lookbackDays }) — full daily run
//
// Both wrap each stage with timing logs and accumulate Claude cost in the
// runs table, so we can see end-of-run "$X total" telemetry.

import { startRun, endRun, getEpisode, totalCostForRun, db } from './lib/db.js';
import { setRunBudget, BudgetExceededError } from './lib/claude.js';
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

// Resolve effective budget: CLI flag wins, falls back to MAX_USD_PER_RUN env, then null.
function resolveMaxUsd(maxUsdArg) {
  if (maxUsdArg != null) return maxUsdArg;
  const env = process.env.MAX_USD_PER_RUN;
  if (env == null || env === '') return null;
  const n = Number(env);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`MAX_USD_PER_RUN must be a non-negative number, got: ${env}`);
  }
  return n;
}

export async function runEpisode({ url, dryRun, maxUsd } = {}) {
  const mode = dryRun ? 'dry-run-episode' : 'episode';
  const run_id = startRun(mode);
  const budget = resolveMaxUsd(maxUsd);
  setRunBudget(run_id, budget);
  if (budget != null) log.info(`budget: $${budget.toFixed(2)} per run`);
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
    setRunBudget(null, null);
    const usd = totalCostForRun(run_id);
    endRun(run_id, { ok, episodes_processed: processed, total_usd: usd });
    log.ok('run complete', { run_id, processed, total_usd: usd.toFixed(4) });
  }
  return briefResult;
}

export async function runDaily({ dryRun, lookbackDays = 2, maxUsd } = {}) {
  const mode = dryRun ? 'dry-run-daily' : 'daily';
  const run_id = startRun(mode);
  const budget = resolveMaxUsd(maxUsd);
  setRunBudget(run_id, budget);
  if (budget != null) log.info(`budget: $${budget.toFixed(2)} per run`);
  let processed = 0, ok = false, briefResult = null;
  let budgetTripped = false;
  try {
    await stage('ingest', () => ingestDaily({ lookbackDays }));

    // Pick up everything ingested-but-not-finished (handles resume of prior partials).
    const pending = resumableEpisodes();
    log.info(`processing ${pending.length} pending episode(s)`);

    const ready = [];
    for (const ep of pending) {
      try {
        if (await processEpisode(ep, run_id)) {
          ready.push(getEpisode(ep.video_id));
          processed++;
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          // The just-failed episode is left at its partial status; next run resumes it.
          // We still compose & deliver a brief from episodes that completed before this.
          log.warn(err.message, { episodes_completed: processed, episodes_remaining: pending.length - processed - 1 });
          budgetTripped = true;
          break;
        }
        throw err;
      }
    }

    const html = await stage('compose', () => composeBrief(ready));
    briefResult = await stage('deliver', () =>
      deliver(html, { dryRun, episodes: ready, date: new Date() })
    );
    ok = !budgetTripped;
  } finally {
    setRunBudget(null, null);
    const usd = totalCostForRun(run_id);
    endRun(run_id, { ok, episodes_processed: processed, total_usd: usd });
    log.ok('run complete', { run_id, processed, total_usd: usd.toFixed(4), budget_tripped: budgetTripped });
  }
  return briefResult;
}
