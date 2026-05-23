// One-off sanity test for the canonicalize() function in stages/5-compose.js.
// Imports the module and exercises common caption-mangled phrases.
// Safe to delete once verified.

import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/stages/5-compose.js', import.meta.url), 'utf8');
// Cheap module-pull: eval the const + function out of the source. We just
// want to test the table; not worth restructuring the module for an export.
const tableStart = src.indexOf('const CANONICAL_TERMS');
const fnEnd = src.indexOf('function fmtTime');
const block = src.slice(tableStart, fnEnd);
const fn = new Function(block + ' return canonicalize;')();

const cases = [
  '90 plus% of our code is actually written by cloud code',
  'a deal with Amazon for tranium for up to 5 gawatts',
  '5 gawatt deal with Google and with Broadcom',
  'a prior model found 22 security vulnerabilities and mythos then found 250',
  'anthropic uses cuda on nvidia hardware',
  'they have TPUs and tpus and Tpus',
  'Anthropic uses CUDA and NVIDIA',                // already correct, should not change
  'cloudy weather in the cloud',                   // false positive check
];

for (const s of cases) {
  const out = fn(s);
  const changed = s === out ? '   ' : ' → ';
  console.log(`IN : ${s}`);
  console.log(`OUT${changed}${out}`);
  console.log();
}
