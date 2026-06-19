// Fidelity gate for the board <-> profile.md round-trip.
//
// Imports the real config/profile.md into board state, regenerates markdown,
// and asserts NO content is lost: the rubric is byte-preserved, every theme
// heading and bullet survives, every down-weight bullet survives, and the
// generate∘import transform is idempotent (so repeated saves don't drift).
//
// Run: node scripts/test-profile-roundtrip.js   (exits non-zero on any loss)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importProfileToBoard, generateProfileMd } from '../src/lib/profile-board-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(__dirname, '..', 'config', 'profile.md');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok  ', msg); }
  else { failures++; console.log('  FAIL', msg); }
}
const collapse = s => String(s).replace(/\s+/g, ' ').trim();
function multisetEqual(a, b, label) {
  const norm = arr => arr.map(collapse).filter(Boolean).sort();
  const A = norm(a), B = norm(b);
  if (A.length !== B.length) { console.log(`     ${label}: count ${A.length} vs ${B.length}`); return false; }
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) { console.log(`     ${label}: missing -> ${A[i] !== B[i] ? A[i] : ''} | ${B[i]}`); return false; }
  return true;
}

// --- extract ground truth straight from the source markdown ---
function sourceFacts(md) {
  const themesOffset = md.match(/^##\s+Themes I care about[^\n]*$/m).index;
  const downOffset = md.match(/^##\s+Down-weight[^\n]*$/m).index;
  const themesBlock = md.slice(themesOffset, downOffset).split(/\r?\n/);
  const downBlock = md.slice(downOffset).split(/\r?\n/);

  const headings = [];
  const themeBullets = [];
  let inTheme = false;
  for (let i = 1; i < themesBlock.length; i++) {
    const h = themesBlock[i].match(/^###\s+(.*\S)\s*$/);
    if (h) { headings.push(h[1].replace(/\(\s*Tier[^)]*\)\s*$/i, '').trim()); inTheme = true; continue; }
    const b = themesBlock[i].match(/^(\s*)[-*]\s+(.*\S)\s*$/);
    if (b && inTheme) { themeBullets.push(b[2]); continue; }
    if (themesBlock[i].trim() && inTheme && themeBullets.length) {
      themeBullets[themeBullets.length - 1] += ' ' + themesBlock[i].trim();
    }
  }
  const downBullets = [];
  for (let i = 1; i < downBlock.length; i++) {
    const b = downBlock[i].match(/^(\s*)[-*]\s+(.*\S)\s*$/);
    if (b) downBullets.push(b[2]);
  }
  return { themesOffset, headings, themeBullets, downBullets };
}

function boardFacts(board) {
  const headings = [];
  const themeBullets = [];
  for (const lane of ['always', 'context']) {
    for (const id of board.lanes[lane]) {
      const t = board.topics[id];
      headings.push(t.name);
      for (const s of t.subtopics) themeBullets.push(s.text);
    }
  }
  const downBullets = [];
  for (const id of board.lanes.mute) {
    const t = board.topics[id];
    downBullets.push(t.name);
    for (const s of t.subtopics) downBullets.push(s.text);
  }
  return { headings, themeBullets, downBullets };
}

console.log('Round-trip fidelity: config/profile.md');
const md = fs.readFileSync(PROFILE, 'utf8');
const board = importProfileToBoard(md);
const md2 = generateProfileMd(board);

const src = sourceFacts(md);
const brd = boardFacts(board);

check(board.rubric === md.slice(0, src.themesOffset), 'rubric is byte-preserved from the source');
check(md2.startsWith(board.rubric.replace(/\s*$/, '')), 'generated md begins with the preserved rubric');
check(multisetEqual(src.headings, brd.headings, 'headings'), `every theme heading survives (${src.headings.length})`);
check(multisetEqual(src.themeBullets, brd.themeBullets, 'theme bullets'), `every theme bullet survives (${src.themeBullets.length})`);
check(multisetEqual(src.downBullets, brd.downBullets, 'down-weight'), `every down-weight bullet survives (${src.downBullets.length})`);
check(md2.trim().length >= 50, 'generated md clears the 50-char floor');

// idempotency: generate∘import is a fixed point starting from the generated md
const board3 = importProfileToBoard(md2);
const md3 = generateProfileMd(board3);
check(md3 === md2, 'generate∘import is idempotent (no drift across saves)');

// every theme heading also appears verbatim in the generated markdown
const md2Headings = (md2.match(/^###\s+(.*)$/gm) || []).map(h => h.replace(/^###\s+/, '').replace(/\(\s*Tier[^)]*\)\s*$/i, '').trim());
check(multisetEqual(src.headings, md2Headings, 'generated headings'), 'generated md contains every theme heading');

if (board._importWarnings?.length) {
  console.log(`\n${board._importWarnings.length} import warning(s):`);
  for (const w of board._importWarnings) console.log('  - ' + w);
}

console.log(failures ? `\nFAILED (${failures})` : '\nPASSED');
process.exit(failures ? 1 : 0);
