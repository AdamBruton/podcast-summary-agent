// Re-rank one or more episodes using the current prompts/rank.md +
// config/profile.md. Useful after editing profile.md to see how the
// ranking shifts without re-running the (expensive) extract pass.
//
// Usage:
//   node scripts/rerank.js                           # re-ranks all delivered + ranked eps
//   node scripts/rerank.js <video_id> [<video_id>]   # re-ranks specific eps
//
// Note: rankEpisode sets status to 'ranked' on success, so previously
// 'delivered' episodes flip back to 'ranked' (so they reappear in
// `recompose.js`). After reviewing the new brief you can resend with
// `node scripts/recompose.js --send` to mark them 'delivered' again.

import { db, startRun, endRun } from '../src/lib/db.js';
import { rankEpisode } from '../src/stages/4-rank.js';
import { log } from '../src/lib/log.js';

let targets;
if (process.argv.length > 2) {
  const ids = process.argv.slice(2);
  targets = db()
    .prepare(`SELECT * FROM episodes WHERE video_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
} else {
  targets = db()
    .prepare(`SELECT * FROM episodes WHERE status IN ('ranked','delivered') ORDER BY published_at DESC`)
    .all();
}

if (!targets.length) {
  log.warn('no episodes to re-rank');
  process.exit(0);
}

const run_id = startRun('rerank');
let ok = false, count = 0, usd = 0;
try {
  for (const ep of targets) {
    log.info(`re-ranking`, { video_id: ep.video_id, title: ep.title?.slice(0, 60) });
    await rankEpisode(ep, { run_id });
    count++;
  }
  const row = db()
    .prepare(`SELECT COALESCE(SUM(usd_cost), 0) AS t FROM cost_ledger WHERE run_id = ?`)
    .get(run_id);
  usd = row.t || 0;
  ok = true;
} finally {
  endRun(run_id, { ok, episodes_processed: count, total_usd: usd });
  log.ok('re-rank complete', { episodes: count, total_usd: usd.toFixed(4) });
}
