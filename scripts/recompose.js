// Re-render (and optionally send) the brief from current DB state. No LLM
// calls — uses whatever rankings exist for episodes in 'ranked' status.
//
// Usage:
//   node scripts/recompose.js           # write HTML to data/briefs/, dry-run
//   node scripts/recompose.js --send    # ALSO send via Resend (requires
//                                       # RESEND_API_KEY/MAIL_FROM/MAIL_TO in .env)
//
// On --send success, episodes are marked 'delivered' so they don't appear
// in subsequent briefs.

import { parseArgs } from 'node:util';
import { db } from '../src/lib/db.js';
import { composeBrief } from '../src/stages/5-compose.js';
import { deliver } from '../src/stages/6-deliver.js';

const { values } = parseArgs({
  options: { send: { type: 'boolean', default: false } },
  strict: true,
});

const eps = db()
  .prepare(`SELECT * FROM episodes WHERE status = 'ranked' ORDER BY published_at DESC`)
  .all();

if (eps.length === 0) {
  console.error('no episodes in ranked status — nothing to compose');
  process.exit(0);
}

console.error(`composing brief from ${eps.length} ranked episode(s):`);
for (const e of eps) console.error(`  - ${e.channel_name}: ${e.title}`);

const html = await composeBrief(eps);
const result = await deliver(html, {
  dryRun: !values.send,
  episodes: eps,
  date: new Date(),
});

if (result.delivered) {
  console.error('email delivered ✓ — episodes marked as delivered');
} else if (result.path) {
  console.error(`brief at: ${result.path}`);
}
