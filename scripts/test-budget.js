// Unit-style test for the cost guardrail. Exercises checkBudget() against a
// synthetic run with rows inserted directly into cost_ledger — avoids paying
// for real Claude calls just to confirm the threshold logic.
//
// Run with: node scripts/test-budget.js

import { startRun, endRun, recordCost, totalCostForRun } from '../src/lib/db.js';
import { setRunBudget, checkBudget, BudgetExceededError } from '../src/lib/claude.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures++;
  }
}
function expectThrow(fn, ErrClass, label) {
  try { fn(); assert(false, `${label} (expected throw, got success)`); }
  catch (e) {
    assert(e instanceof ErrClass, `${label} (threw ${e.constructor.name})`);
  }
}

console.log('cost guardrail');

const run_id = startRun('test');

console.log('  setup: no budget');
setRunBudget(null, null);
assert(checkBudget() === undefined, 'no-budget → checkBudget is a no-op');

console.log('  setup: budget $1.00, under spend');
setRunBudget(run_id, 1.00);
recordCost({ run_id, video_id: 'test1', stage: 'extract', model: 'm', input_tokens: 1, cached_tokens: 0, output_tokens: 1, usd_cost: 0.50 });
assert(totalCostForRun(run_id) === 0.50, 'totalCostForRun reads 0.50');
assert(checkBudget() === undefined, 'under-budget → no throw');

console.log('  spend pushes over budget');
recordCost({ run_id, video_id: 'test1', stage: 'extract', model: 'm', input_tokens: 1, cached_tokens: 0, output_tokens: 1, usd_cost: 0.60 });
assert(Math.abs(totalCostForRun(run_id) - 1.10) < 1e-9, 'totalCostForRun reads 1.10');
expectThrow(() => checkBudget(), BudgetExceededError, 'over-budget → throws BudgetExceededError');

console.log('  cleared budget after run');
setRunBudget(null, null);
assert(checkBudget() === undefined, 'cleared → no throw even when ledger is over');

console.log('  zero budget aborts after any spend');
const run2 = startRun('test');
setRunBudget(run2, 0);
recordCost({ run_id: run2, video_id: 'test2', stage: 'extract', model: 'm', input_tokens: 1, cached_tokens: 0, output_tokens: 1, usd_cost: 0.001 });
expectThrow(() => checkBudget(), BudgetExceededError, 'zero-budget + any cost → throws');

setRunBudget(null, null);
endRun(run_id, { ok: 1, episodes_processed: 0, total_usd: totalCostForRun(run_id) });
endRun(run2,   { ok: 0, episodes_processed: 0, total_usd: totalCostForRun(run2) });

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall ok');
