// Standalone discovery run. Searches YouTube for the configured individuals,
// runs the LLM curation, and persists results to the `discoveries` table.
//
// Usage:
//   node scripts/discover.js                       # all individuals, do NOT auto-promote
//   node scripts/discover.js --promote             # also insert approvals into episodes
//   node scripts/discover.js --names "Jensen Huang,Dario Amodei"
//                                                   # restrict to specific names (comma-sep)
//   node scripts/discover.js --results 5           # smaller search-result count (cheap test)
//
// Default mode is *no auto-promote* — you can inspect the audit (`npm run
// discovery:audit`) before letting anything enter the brief pipeline.

import { parseArgs } from 'node:util';
import { discoverIndividuals } from '../src/stages/1b-discover.js';
import { startRun, endRun, db } from '../src/lib/db.js';
import { log } from '../src/lib/log.js';

const { values } = parseArgs({
  options: {
    promote: { type: 'boolean', default: false },
    names:   { type: 'string' },
    results: { type: 'string' },
  },
  strict: true,
});

const names = values.names
  ? values.names.split(',').map(s => s.trim()).filter(Boolean)
  : null;
const resultsPerName = values.results ? Number(values.results) : null;

const run_id = startRun(values.promote ? 'discover-promote' : 'discover-test');
let ok = false;
let totals = null;
try {
  totals = await discoverIndividuals({
    run_id,
    promote: values.promote,
    names,
    resultsPerName,
  });
  ok = true;
} finally {
  const row = db()
    .prepare(`SELECT COALESCE(SUM(usd_cost), 0) AS t FROM cost_ledger WHERE run_id = ?`)
    .get(run_id);
  endRun(run_id, { ok, episodes_processed: totals?.promoted || 0, total_usd: row.t || 0 });
  log.ok('discover run', {
    run_id,
    ...(totals || {}),
    promote_mode: values.promote,
    total_usd:    (row.t || 0).toFixed(4),
  });
}
