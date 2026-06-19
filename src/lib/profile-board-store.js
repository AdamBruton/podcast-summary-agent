// Structured "board" representation of the interest profile.
//
// The board is the source of truth for the themes/down-weight structure; the
// freeform config/profile.md (the ranker's verbatim bias function) is GENERATED
// from it on save. The hand-authored preamble (everything before
// "## Themes I care about" — title, "How to extend", "Priority hierarchy") is
// preserved byte-for-byte as `rubric` and re-emitted unchanged.
//
// The ranker reads profile.md as opaque text (4-rank.js / global-rank.js /
// 1b-discover.js concatenate loadProfile() into the system prompt; nothing
// parses headings), so any well-formed markdown this generates works unchanged.
//
// Lanes map to tiers: always -> Tier 1, context -> Tier 2, mute -> Down-weight.
// Position within a lane is the explicit priority (rank 1 = first).

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { readProfile, writeProfile } from './profile-store.js';

const PROFILE_PATH   = path.join(CONFIG_DIR, 'profile.md');
const BOARD_PATH     = path.join(CONFIG_DIR, 'profile.board.json');
const PRE_BOARD_PATH = path.join(CONFIG_DIR, 'profile.pre-board.md');

const LANES = ['always', 'context', 'mute'];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic';
}
function uniqueId(base, topics) {
  let id = base, n = 2;
  while (topics[id]) id = `${base}-${n++}`;
  return id;
}
function collapseWs(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------------------
// import: profile.md  ->  board
// ---------------------------------------------------------------------------

// Tolerant tier annotation: "(Tier 1)", "(Tier 2a)", "(Tier 1 · priority 3)".
const TIER_RE = /\(\s*Tier\s*([0-9])\s*[ab]?\s*(?:[·:\-]\s*priority\s*\d+\s*)?\)\s*$/i;
const HEADING_RE = /^###\s+(.*\S)\s*$/;
const BULLET_RE  = /^(\s*)[-*]\s+(.*\S)\s*$/;        // group1 = indent, group2 = text
const ORDERED_RE = /^(\s*)\d+\.\s+(.*\S)\s*$/;

export function importProfileToBoard(md) {
  const warnings = [];
  const board = {
    version: 1,
    rubric: '',
    themesIntro: '',
    downWeightIntro: '',
    lanes: { always: [], context: [], mute: [] },
    topics: {},
    _importWarnings: warnings,
  };
  const text = typeof md === 'string' ? md : '';

  const themesMatch = text.match(/^##\s+Themes I care about[^\n]*$/m);
  const downMatch   = text.match(/^##\s+Down-weight[^\n]*$/m);

  if (!themesMatch) {
    // No themes section — preserve the whole file as the rubric, no topics.
    board.rubric = text;
    warnings.push("No '## Themes I care about' heading found — kept the whole profile as the preserved preamble; no topic cards were created.");
    return board;
  }
  const themesOffset = themesMatch.index;
  const downValid = downMatch && downMatch.index > themesOffset;
  const downOffset = downValid ? downMatch.index : text.length;
  if (downMatch && !downValid) {
    warnings.push("'## Down-weight' appeared before '## Themes I care about' — ignored its position; no mute items imported.");
  }

  // rubric = exact bytes before the themes heading (byte-preserved).
  board.rubric = text.slice(0, themesOffset);

  parseThemes(text.slice(themesOffset, downOffset), board, warnings);
  if (downValid) parseDownWeight(text.slice(downOffset), board);

  return board;
}

function parseThemes(block, board, warnings) {
  const lines = block.split(/\r?\n/);
  let cur = null;            // current topic object
  const intro = [];
  let seenHeading = false;

  for (let i = 1; i < lines.length; i++) {   // skip line 0 (the "## Themes" heading)
    const raw = lines[i];
    const h = raw.match(HEADING_RE);
    if (h) {
      seenHeading = true;
      cur = makeThemeTopic(h[1].trim(), board, warnings);
      continue;
    }
    const b = raw.match(BULLET_RE) || raw.match(ORDERED_RE);
    if (b && cur) { cur.subtopics.push({ text: collapseWs(b[2]), auto: false }); continue; }
    if (raw.trim() && cur && cur.subtopics.length) {
      // soft-wrap continuation of the previous bullet
      const last = cur.subtopics[cur.subtopics.length - 1];
      last.text = collapseWs(last.text + ' ' + raw.trim());
      continue;
    }
    if (raw.trim() && !seenHeading) intro.push(raw);   // any pre-heading prose
  }
  board.themesIntro = intro.join('\n').trim();
}

function makeThemeTopic(headingText, board, warnings) {
  let name = headingText.replace(/<!--.*?-->\s*$/, '').trim();
  const tier = name.match(TIER_RE);
  let lane;
  if (tier) {
    name = name.slice(0, tier.index).trim() || headingText;
    const n = tier[1];
    if (n === '1') lane = 'always';
    else if (n === '2') lane = 'context';
    else { lane = 'context'; warnings.push(`Theme "${name}" was Tier ${n} — placed in Context; move it if needed.`); }
  } else {
    lane = 'context';
    warnings.push(`Theme "${name}" had no (Tier N) annotation — placed in Context. Drag it to "Always surface" if it's a must-have theme.`);
  }
  const id = uniqueId('t-' + slug(name), board.topics);
  const topic = { id, name, blurb: '', subtopics: [] };
  board.topics[id] = topic;
  board.lanes[lane].push(id);
  return topic;
}

function parseDownWeight(block, board) {
  const lines = block.split(/\r?\n/);
  const intro = [];
  let seenBullet = false;
  let cur = null;

  for (let i = 1; i < lines.length; i++) {   // skip line 0 (the "## Down-weight" heading)
    const raw = lines[i];
    const b = raw.match(BULLET_RE);
    if (b) {
      seenBullet = true;
      if (b[1].length > 0 && cur) {
        // indented bullet -> subtopic of the current mute card (round-trips generated output)
        cur.subtopics.push({ text: collapseWs(b[2]), auto: false });
      } else {
        const id = uniqueId('t-mute-' + slug(b[2]), board.topics);
        cur = { id, name: collapseWs(b[2]), blurb: '', subtopics: [] };
        board.topics[id] = cur;
        board.lanes.mute.push(id);
      }
      continue;
    }
    if (raw.trim() && !seenBullet) { intro.push(raw); continue; }
    if (raw.trim() && cur) {
      // soft-wrap continuation: append to the last subtopic if any, else the name
      if (cur.subtopics.length) {
        const last = cur.subtopics[cur.subtopics.length - 1];
        last.text = collapseWs(last.text + ' ' + raw.trim());
      } else {
        cur.name = collapseWs(cur.name + ' ' + raw.trim());
      }
    }
  }
  board.downWeightIntro = intro.join('\n').trim();
}

// ---------------------------------------------------------------------------
// generate: board  ->  profile.md
// ---------------------------------------------------------------------------

export function generateProfileMd(board) {
  const topics = board.topics || {};
  let md = board.rubric || '# Interest Profile\n';
  // The rubric is emitted verbatim; ensure exactly one blank line before Themes.
  md = md.replace(/\s*$/, '') + '\n\n';

  md += '## Themes I care about\n\n';
  if (board.themesIntro) md += board.themesIntro.trim() + '\n\n';

  const emitLane = (laneIds, tier) => {
    (laneIds || []).forEach((id, i) => {
      const t = topics[id];
      if (!t) return;
      md += `### ${t.name}  (Tier ${tier} · priority ${i + 1})\n`;
      for (const s of (t.subtopics || [])) md += `- ${s.text}\n`;
      md += '\n';
    });
  };
  emitLane(board.lanes?.always, 1);
  emitLane(board.lanes?.context, 2);

  md += '## Down-weight\n\n';
  md += (board.downWeightIntro || 'These are noise — rank lower or drop entirely:').trim() + '\n';
  for (const id of (board.lanes?.mute || [])) {
    const t = topics[id];
    if (!t) continue;
    md += `- ${t.name}\n`;
    for (const s of (t.subtopics || [])) md += `  - ${s.text}\n`;
  }
  if (!md.endsWith('\n')) md += '\n';
  return md;
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

export function readBoard() {
  if (!fs.existsSync(BOARD_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`profile.board.json is corrupt: ${err.message}`);
  }
}

// Throws messages containing a keyword wrap() maps to HTTP 400 (bad input):
// "must" / "required". Bad board state is a client error, not a 500.
function validateBoard(b) {
  if (!b || typeof b !== 'object') throw new Error('board must be an object');
  if (b.version !== 1) throw new Error('board version must be 1');
  if (typeof b.rubric !== 'string' || !b.rubric.trim()) throw new Error('board.rubric (non-empty string) is required');
  if (!b.topics || typeof b.topics !== 'object') throw new Error('board.topics must be an object');
  if (!b.lanes || typeof b.lanes !== 'object') throw new Error('board.lanes must be an object');
  for (const l of LANES) {
    if (!Array.isArray(b.lanes[l])) throw new Error(`board.lanes.${l} must be an array`);
    for (const id of b.lanes[l]) {
      if (!b.topics[id]) throw new Error(`bad board: lane "${l}" references topic "${id}" that must exist in topics`);
    }
  }
}

// Build the board for the API: persisted file if present, else a one-time
// in-memory import of the current profile.md (NOT written until the user saves).
export function loadOrImportBoard() {
  const existing = readBoard();
  if (existing) return { board: existing, source: 'file', warnings: [] };
  const board = importProfileToBoard(readProfile());
  return { board, source: 'imported', warnings: board._importWarnings || [] };
}

// Re-derive board state from the current profile.md WITHOUT regenerating the
// file. Called after a raw / refine edit (which writes profile.md directly) so
// the board view stays consistent. Only persists when board mode is already
// active (board.json exists); otherwise it's a no-op the next GET will import.
export function syncBoardFromProfile() {
  if (!fs.existsSync(BOARD_PATH)) return null;
  const board = importProfileToBoard(readProfile());
  const toSave = { ...board, updatedAt: new Date().toISOString() };
  delete toSave._importWarnings;
  const tmp = BOARD_PATH + '.incoming';
  fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
  fs.renameSync(tmp, BOARD_PATH);
  return board;
}

// Persist the board: regenerate profile.md (via the shared writeProfile floor),
// back up the pristine profile.md once, then atomically write board.json.
export function writeBoard(board) {
  validateBoard(board);
  const md = generateProfileMd(board);

  let backedUp = false;
  if (fs.existsSync(PROFILE_PATH) && !fs.existsSync(PRE_BOARD_PATH)) {
    fs.copyFileSync(PROFILE_PATH, PRE_BOARD_PATH);
    backedUp = true;
  }
  const res = writeProfile(md);   // enforces the 50-char floor; single write path

  const toSave = { ...board, updatedAt: new Date().toISOString() };
  delete toSave._importWarnings;
  const tmp = BOARD_PATH + '.incoming';
  fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
  fs.renameSync(tmp, BOARD_PATH);

  return { saved: true, bytes: res.bytes, backedUp, generated_md: md };
}
