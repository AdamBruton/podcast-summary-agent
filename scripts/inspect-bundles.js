// Dump the ranking + bundle structure for an episode. Useful for verifying
// the rank pass is bundling sensibly. Safe to delete.
import { db } from '../src/lib/db.js';

const video_id = process.argv[2] || 'wEEZPpx8qow';

const rows = db().prepare(`
  SELECT r.id, r.rank, r.label, r.why_matters, r.candidate_id,
         (SELECT COUNT(*) FROM ranking_bundle_members WHERE ranking_id = r.id) AS extras
  FROM rankings r WHERE r.video_id = ? ORDER BY r.rank
`).all(video_id);

const candStmt = db().prepare('SELECT id, timestamp_sec, claim FROM candidates WHERE id = ?');
const memberStmt = db().prepare(`
  SELECT c.id, c.timestamp_sec, c.claim
  FROM ranking_bundle_members rbm JOIN candidates c ON c.id = rbm.candidate_id
  WHERE ranking_id = ? ORDER BY rbm.display_order
`);
const fmtT = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;

for (const r of rows) {
  const tag = r.extras > 0 ? `BUNDLE(${r.extras + 1})` : 'single';
  console.log(`#${r.rank}  ${tag}${r.label ? ` — ${r.label}` : ''}`);
  console.log(`    why: ${r.why_matters}`);
  const primary = candStmt.get(r.candidate_id);
  console.log(`    [${fmtT(primary.timestamp_sec)}] ${primary.claim}`);
  if (r.extras > 0) {
    for (const m of memberStmt.all(r.id)) {
      console.log(`    [${fmtT(m.timestamp_sec)}] ${m.claim}`);
    }
  }
  console.log();
}
