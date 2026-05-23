// Audit recent discovery runs. Shows what got approved, rejected, and
// mechanically filtered over the past N days, so you can sanity-check the
// LLM's judgment and tune the prompt or filters.
//
// Usage:
//   node scripts/discovery-audit.js          # last 7 days, all decisions
//   node scripts/discovery-audit.js 14       # last 14 days
//   node scripts/discovery-audit.js 7 approve   # only approved
//   node scripts/discovery-audit.js 7 reject    # only rejected (LLM-rejected)
//   node scripts/discovery-audit.js 7 filtered  # only mechanically filtered

import { listRecentDiscoveries } from '../src/lib/db.js';

const days = Number(process.argv[2]) || 7;
const decision = process.argv[3] || null;

const rows = listRecentDiscoveries({ days, decision });

if (rows.length === 0) {
  console.log(`No discoveries in the last ${days} days${decision ? ` (decision=${decision})` : ''}.`);
  process.exit(0);
}

const counts = { approve: 0, reject: 0, filtered: 0 };
for (const r of rows) counts[r.decision] = (counts[r.decision] || 0) + 1;

console.log(`Discoveries in last ${days} days:`);
console.log(`  approved:  ${counts.approve  || 0}${counts.approve  ? ` (${rows.filter(r => r.decision === 'approve'  && r.promoted).length} promoted)` : ''}`);
console.log(`  rejected:  ${counts.reject   || 0}  (LLM said no)`);
console.log(`  filtered:  ${counts.filtered || 0}  (mechanical pre-filter)`);
console.log();

const filt = decision ? rows : rows;
for (const r of filt) {
  const tag =
    r.decision === 'approve'  ? (r.promoted ? '✓ APPROVED+PROMOTED' : '✓ APPROVED') :
    r.decision === 'reject'   ? '✗ REJECTED' :
                                '○ FILTERED';
  const dur = r.duration_sec ? `${Math.round(r.duration_sec/60)}min` : '?';
  console.log(`${tag}  [${r.searched_for}]  ${r.channel_name} · ${dur} · ${r.upload_date || '?'}`);
  console.log(`    ${r.title}`);
  if (r.decision_reason) console.log(`    reason: ${r.decision_reason}`);
  console.log(`    ${r.url}`);
  console.log();
}
