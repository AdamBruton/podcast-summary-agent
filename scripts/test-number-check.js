// Sanity test for verifyNumericFidelity. Runs representative cases including
// the original Krishna $75B → $7.5B regression and several edge cases.
// Safe to delete; useful to keep for regression-checking the rule.

import { verifyNumericFidelity } from '../src/lib/number-check.js';

const cases = [
  {
    label: 'KRISHNA REGRESSION — claim has 7.5/5, quote has 75/50: should FAIL',
    claim: 'Anthropic has raised $7.5 billion since Krishna joined, with another $5 billion committed.',
    quote: "We've raised um you know $75 billion since I joined the company. We have another $50 billion that'll come in.",
    expectOk: false,
  },
  {
    label: 'KRISHNA FIXED — claim 75/50 matches quote: should PASS',
    claim: 'Anthropic has raised $75 billion since Krishna joined, with another $50 billion committed.',
    quote: "We've raised um you know $75 billion since I joined. We have another $50 billion in the future.",
    expectOk: true,
  },
  {
    label: 'WORD NUMBER — claim "9 of Fortune 10", quote "nine of the Fortune 10": should PASS',
    claim: 'Anthropic sells to 9 of the Fortune 10 companies.',
    quote: 'we now sell to nine of the Fortune 10, all of those enterprises',
    expectOk: true,
  },
  {
    label: 'MATCHING DECIMALS — claim "3.4%" quote "3.4%": should PASS',
    claim: 'Grok holds only 3.4% market share in enterprise AI.',
    quote: 'SpaceX’s own AI product, Grock, holds a market share of roughly 3.4%.',
    expectOk: true,
  },
  {
    label: 'PERCENT MISMATCH — claim 60% quote 90%: should FAIL',
    claim: 'Over 60% of Anthropic\'s code is written by Claude Code.',
    quote: 'within the company you know 90 plus% of our code is actually written by Claude Code',
    expectOk: false,
  },
  {
    label: 'NO NUMBERS IN CLAIM — should PASS trivially',
    claim: 'Jensen calls export controls counterproductive.',
    quote: 'comparing AI to that is lunacy',
    expectOk: true,
  },
  {
    label: 'SUBSTRING TRAP — claim "5 gigawatts" quote "5 gawatts" (canonicalized later): should PASS',
    claim: 'Anthropic signed a 5-gigawatt deal with Google.',
    quote: 'we signed a 5 gawatt deal with Google',
    expectOk: true,
  },
  {
    label: 'YEAR — claim "in 2027" quote "starting in 2027": should PASS',
    claim: 'Deal starts in 2027.',
    quote: 'starting in 2027.',
    expectOk: true,
  },
];

let passed = 0, failed = 0;
for (const c of cases) {
  const r = verifyNumericFidelity(c.claim, c.quote);
  const ok = r.ok === c.expectOk;
  console.log(`${ok ? '✓' : '✗'} ${c.label}`);
  console.log(`   ok=${r.ok}, expected=${c.expectOk}, missing=[${r.missing.join(', ')}]`);
  if (ok) passed++; else failed++;
}
console.log();
console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
