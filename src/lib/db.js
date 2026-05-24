// SQLite state via Node's built-in node:sqlite (no native dep).
// Tracks: episodes, transcripts, candidates, rankings, runs, cost_ledger.

import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';

let _db = null;

export function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  migrate(_db);
  return _db;
}

// SQLite CREATE TABLE IF NOT EXISTS doesn't add columns to existing tables,
// so for DBs created before a column was added (episodes pre-discovery feature),
// we add columns idempotently. Duplicate-column errors are swallowed.
function safeAlter(d, sql) {
  try { d.exec(sql); }
  catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      video_id      TEXT PRIMARY KEY,
      channel_id    TEXT,
      channel_name  TEXT,
      title         TEXT,
      description   TEXT,
      published_at  TEXT,
      duration_sec  INTEGER,
      url           TEXT,
      status        TEXT DEFAULT 'new',  -- new|transcribed|extracted|ranked|delivered|skipped
      skip_reason   TEXT,
      source        TEXT DEFAULT 'subscribed',  -- subscribed|discovery
      discovered_for TEXT,                       -- if source='discovery', the individual we searched for
      ingested_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS discoveries (
      video_id         TEXT PRIMARY KEY,
      searched_for     TEXT,                    -- the individual name we ran the search for
      title            TEXT,
      channel_name     TEXT,
      duration_sec     INTEGER,
      upload_date      TEXT,                    -- ISO date 'YYYY-MM-DD'
      url              TEXT,
      decision         TEXT,                    -- 'approve' | 'reject' | 'filtered' (pre-LLM cut)
      decision_reason  TEXT,
      promoted         INTEGER DEFAULT 0,       -- 1 if approved AND inserted into episodes
      discovered_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_discoveries_decision ON discoveries(decision);
    CREATE INDEX IF NOT EXISTS idx_discoveries_searched ON discoveries(searched_for);

    CREATE TABLE IF NOT EXISTS transcripts (
      video_id      TEXT PRIMARY KEY REFERENCES episodes(video_id),
      source        TEXT,                 -- captions|whisper
      language      TEXT,
      duration_sec  INTEGER,
      cues_json     TEXT,                 -- JSON array of {start, end, text}
      fetched_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id          TEXT REFERENCES episodes(video_id),
      timestamp_sec     INTEGER,
      speaker           TEXT,
      claim             TEXT,
      category          TEXT,
      novelty_score     REAL,
      supporting_quote  TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_video ON candidates(video_id);

    CREATE TABLE IF NOT EXISTS rankings (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id              TEXT REFERENCES episodes(video_id),
      candidate_id          INTEGER REFERENCES candidates(id),
      rank                  INTEGER,
      why_matters           TEXT,
      included_in_brief_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rankings_video ON rankings(video_id);

    CREATE TABLE IF NOT EXISTS runs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at           TEXT DEFAULT (datetime('now')),
      ended_at             TEXT,
      mode                 TEXT,           -- daily|episode|dry-run
      episodes_processed   INTEGER DEFAULT 0,
      total_usd            REAL DEFAULT 0,
      ok                   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS feedback (
      candidate_id    INTEGER PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
      rating          TEXT NOT NULL CHECK (rating IN ('up', 'down')),
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Bundle members: extra candidates that belong to the same ranking as
    -- rankings.candidate_id (the "primary"). Singles have no rows here.
    -- Lets one brief item present 2-3 timestamped moments together when
    -- they form a richer story than any one alone.
    CREATE TABLE IF NOT EXISTS ranking_bundle_members (
      ranking_id      INTEGER NOT NULL REFERENCES rankings(id)   ON DELETE CASCADE,
      candidate_id    INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
      display_order   INTEGER DEFAULT 0,
      PRIMARY KEY (ranking_id, candidate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rbm_candidate ON ranking_bundle_members(candidate_id);

    CREATE TABLE IF NOT EXISTS cost_ledger (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER REFERENCES runs(id),
      video_id        TEXT,
      stage           TEXT,
      model           TEXT,
      input_tokens    INTEGER DEFAULT 0,
      cached_tokens   INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      usd_cost        REAL DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );
  `);

  // Idempotent column additions for DBs that predate later features.
  safeAlter(d, `ALTER TABLE episodes ADD COLUMN source TEXT DEFAULT 'subscribed'`);
  safeAlter(d, `ALTER TABLE episodes ADD COLUMN discovered_for TEXT`);
  safeAlter(d, `ALTER TABLE rankings ADD COLUMN label TEXT`);
}

// --- Episode helpers --------------------------------------------------------

export function upsertEpisode(ep) {
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO episodes (video_id, channel_id, channel_name, title, description, published_at,
                          duration_sec, url, source, discovered_for)
    VALUES (@video_id, @channel_id, @channel_name, @title, @description, @published_at,
            @duration_sec, @url, @source, @discovered_for)
    ON CONFLICT(video_id) DO NOTHING
  `);
  const info = stmt.run({
    source:         'subscribed',
    discovered_for: null,
    ...ep,
  });
  return info.changes > 0; // true if newly inserted
}

export function setEpisodeStatus(video_id, status, skip_reason = null) {
  db().prepare(`UPDATE episodes SET status = ?, skip_reason = ? WHERE video_id = ?`)
      .run(status, skip_reason, video_id);
}

export function getEpisode(video_id) {
  return db().prepare(`SELECT * FROM episodes WHERE video_id = ?`).get(video_id);
}

export function listEpisodes({ status } = {}) {
  if (status) {
    return db().prepare(`SELECT * FROM episodes WHERE status = ? ORDER BY published_at DESC`)
               .all(status);
  }
  return db().prepare(`SELECT * FROM episodes ORDER BY published_at DESC`).all();
}

// --- Transcript helpers -----------------------------------------------------

export function saveTranscript({ video_id, source, language, duration_sec, cues }) {
  db().prepare(`
    INSERT INTO transcripts (video_id, source, language, duration_sec, cues_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      source = excluded.source,
      language = excluded.language,
      duration_sec = excluded.duration_sec,
      cues_json = excluded.cues_json,
      fetched_at = datetime('now')
  `).run(video_id, source, language, duration_sec, JSON.stringify(cues));
}

export function getTranscript(video_id) {
  const row = db().prepare(`SELECT * FROM transcripts WHERE video_id = ?`).get(video_id);
  if (!row) return null;
  return { ...row, cues: JSON.parse(row.cues_json) };
}

// --- Candidates / rankings --------------------------------------------------

export function saveCandidates(video_id, candidates) {
  const d = db();
  // Replace any prior extraction for idempotency. Rankings reference candidate
  // IDs we're about to invalidate (FK ON), so clear them first.
  d.prepare(`DELETE FROM rankings WHERE video_id = ?`).run(video_id);
  d.prepare(`DELETE FROM candidates WHERE video_id = ?`).run(video_id);
  const stmt = d.prepare(`
    INSERT INTO candidates (video_id, timestamp_sec, speaker, claim, category, novelty_score, supporting_quote)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  for (const c of candidates) {
    const info = stmt.run(
      video_id,
      c.timestamp_sec ?? 0,
      c.speaker ?? null,
      c.claim,
      c.category ?? null,
      c.novelty_score ?? null,
      c.supporting_quote ?? null,
    );
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

export function getCandidates(video_id) {
  return db().prepare(`SELECT * FROM candidates WHERE video_id = ? ORDER BY timestamp_sec`)
             .all(video_id);
}

// Accepts two ranking shapes from the rank pass:
//   single:  { candidate_id, rank, why_matters }
//   bundle:  { candidate_ids: [primary, …extras], rank, why_matters, label? }
// In both cases the FIRST id becomes rankings.candidate_id (the "primary").
// Extras are inserted into ranking_bundle_members. Singles get no junction rows.
export function saveRankings(video_id, rankings) {
  const d = db();
  d.prepare(`DELETE FROM rankings WHERE video_id = ?`).run(video_id);
  const insertRanking = d.prepare(`
    INSERT INTO rankings (video_id, candidate_id, rank, why_matters, label)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMember = d.prepare(`
    INSERT INTO ranking_bundle_members (ranking_id, candidate_id, display_order)
    VALUES (?, ?, ?)
  `);
  for (const r of rankings) {
    const ids = Array.isArray(r.candidate_ids) && r.candidate_ids.length
      ? r.candidate_ids
      : [r.candidate_id];
    if (ids.length === 0 || ids[0] == null) continue;   // malformed entry, skip
    const info = insertRanking.run(video_id, ids[0], r.rank, r.why_matters, r.label || null);
    const ranking_id = Number(info.lastInsertRowid);
    for (let i = 1; i < ids.length; i++) {
      insertMember.run(ranking_id, ids[i], i);
    }
  }
}

// Each ranking returned is one brief item. Singles have an empty bundle_members
// array. Bundles list their extra candidates in bundle_members ordered by
// display_order (the order the rank pass listed them).
export function getRankedBriefItems(video_id) {
  const rankings = db().prepare(`
    SELECT r.id AS ranking_id, r.rank, r.why_matters, r.label, c.*
    FROM rankings r
    JOIN candidates c ON c.id = r.candidate_id
    WHERE r.video_id = ?
    ORDER BY r.rank
  `).all(video_id);
  const memberStmt = db().prepare(`
    SELECT c.*
    FROM ranking_bundle_members rbm
    JOIN candidates c ON c.id = rbm.candidate_id
    WHERE rbm.ranking_id = ?
    ORDER BY rbm.display_order, c.timestamp_sec
  `);
  for (const r of rankings) {
    r.bundle_members = memberStmt.all(r.ranking_id);
  }
  return rankings;
}

export function markDelivered(video_id) {
  db().prepare(`UPDATE rankings SET included_in_brief_at = datetime('now') WHERE video_id = ?`)
      .run(video_id);
}

// --- Runs / cost ------------------------------------------------------------

export function startRun(mode) {
  const info = db().prepare(`INSERT INTO runs (mode) VALUES (?)`).run(mode);
  return Number(info.lastInsertRowid);
}

export function endRun(run_id, { ok, episodes_processed, total_usd }) {
  db().prepare(`
    UPDATE runs SET ended_at = datetime('now'), ok = ?, episodes_processed = ?, total_usd = ?
    WHERE id = ?
  `).run(ok ? 1 : 0, episodes_processed, total_usd, run_id);
}

export function recordCost({ run_id, video_id, stage, model, input_tokens, cached_tokens, output_tokens, usd_cost }) {
  db().prepare(`
    INSERT INTO cost_ledger (run_id, video_id, stage, model, input_tokens, cached_tokens, output_tokens, usd_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run_id, video_id, stage, model, input_tokens, cached_tokens, output_tokens, usd_cost);
}

// --- Discoveries ------------------------------------------------------------

export function hasDiscovery(video_id) {
  return !!db().prepare(`SELECT 1 FROM discoveries WHERE video_id = ?`).get(video_id);
}

export function hasEpisode(video_id) {
  return !!db().prepare(`SELECT 1 FROM episodes WHERE video_id = ?`).get(video_id);
}

export function saveDiscovery(rec) {
  db().prepare(`
    INSERT INTO discoveries (video_id, searched_for, title, channel_name, duration_sec,
                             upload_date, url, decision, decision_reason, promoted)
    VALUES (@video_id, @searched_for, @title, @channel_name, @duration_sec,
            @upload_date, @url, @decision, @decision_reason, @promoted)
    ON CONFLICT(video_id) DO UPDATE SET
      decision        = excluded.decision,
      decision_reason = excluded.decision_reason,
      promoted        = excluded.promoted
  `).run({ promoted: 0, decision_reason: null, ...rec });
}

export function markDiscoveryPromoted(video_id) {
  db().prepare(`UPDATE discoveries SET promoted = 1 WHERE video_id = ?`).run(video_id);
}

// --- Episode inspector (for web UI) ----------------------------------------

// Recent episodes with candidate + ranking counts, newest-first.
// Excludes episodes still in 'new' state (nothing to inspect yet) and those
// 'skipped' (no transcript). Limit defaults to 25 to keep payloads small.
export function listEpisodesWithCounts({ limit = 25 } = {}) {
  return db().prepare(`
    SELECT
      e.video_id,
      e.title,
      e.channel_name,
      e.published_at,
      e.status,
      e.source,
      e.discovered_for,
      e.url,
      e.duration_sec,
      (SELECT COUNT(*) FROM candidates c WHERE c.video_id = e.video_id) AS candidate_count,
      (SELECT COUNT(*) FROM rankings   r WHERE r.video_id = e.video_id) AS ranking_count
    FROM episodes e
    WHERE e.status IN ('extracted', 'ranked', 'delivered')
    ORDER BY e.published_at DESC, e.ingested_at DESC
    LIMIT ?
  `).all(limit);
}

// All candidates for one episode, with selected/rank/why_matters joined from
// rankings via LEFT JOIN, plus the user's current feedback rating (up/down/null).
// Dropped candidates have rank=null, why_matters=null. Selected items are
// returned in rank order (1, 2, 3, ...); dropped items are ordered by
// novelty_score desc as a secondary signal.
// A candidate is "selected" if it's either:
//   - the primary of a ranking (rankings.candidate_id = c.id), OR
//   - a bundle member of a ranking (via ranking_bundle_members).
// In either case we surface the parent ranking's rank + why_matters so the
// inspector shows the candidate alongside the rest of its bundle.
export function getEpisodeDetail(video_id) {
  const ep = db().prepare(`SELECT * FROM episodes WHERE video_id = ?`).get(video_id);
  if (!ep) return null;
  const candidates = db().prepare(`
    SELECT
      c.id,
      c.timestamp_sec,
      c.speaker,
      c.claim,
      c.category,
      c.novelty_score,
      c.supporting_quote,
      COALESCE(r_pri.rank,         r_bun.rank)         AS rank,
      COALESCE(r_pri.why_matters,  r_bun.why_matters)  AS why_matters,
      COALESCE(r_pri.label,        r_bun.label)        AS label,
      COALESCE(r_pri.id,           r_bun.id)           AS ranking_id,
      CASE WHEN r_pri.id IS NULL AND rbm.ranking_id IS NULL THEN 0 ELSE 1 END AS selected,
      CASE WHEN rbm.ranking_id IS NULL THEN 0 ELSE 1 END AS is_bundle_member,
      f.rating AS feedback
    FROM candidates c
    LEFT JOIN rankings r_pri              ON r_pri.candidate_id = c.id AND r_pri.video_id = c.video_id
    LEFT JOIN ranking_bundle_members rbm  ON rbm.candidate_id   = c.id
    LEFT JOIN rankings r_bun              ON r_bun.id           = rbm.ranking_id AND r_bun.video_id = c.video_id
    LEFT JOIN feedback f                  ON f.candidate_id     = c.id
    WHERE c.video_id = ?
    ORDER BY
      CASE WHEN r_pri.rank IS NULL AND r_bun.rank IS NULL THEN 1 ELSE 0 END,
      COALESCE(r_pri.rank, r_bun.rank, 0),
      c.novelty_score DESC,
      c.timestamp_sec ASC
  `).all(video_id);
  return { episode: ep, candidates };
}

// --- Feedback ---------------------------------------------------------------

// Set, change, or clear a candidate's rating. rating=null deletes the row.
export function setFeedback(candidate_id, rating) {
  if (rating == null) {
    db().prepare(`DELETE FROM feedback WHERE candidate_id = ?`).run(candidate_id);
    return { candidate_id, rating: null };
  }
  if (rating !== 'up' && rating !== 'down') throw new Error(`bad rating: ${rating}`);
  db().prepare(`
    INSERT INTO feedback (candidate_id, rating)
    VALUES (?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      rating     = excluded.rating,
      updated_at = datetime('now')
  `).run(candidate_id, rating);
  return { candidate_id, rating };
}

// All feedback with the context an LLM needs to suggest profile refinements:
// the candidate's claim/quote/category/novelty + whether it was selected by
// the ranker + the ranker's why_matters (if selected) + episode/channel.
//
// Returns rows with the 4-quadrant outcome computed:
//   ✓ correct:           (selected=1 + rating=up)  OR  (selected=0 + rating=down)
//   ✗ false_positive:    selected=1 + rating=down  (shouldn't have been included)
//   ✗ false_negative:    selected=0 + rating=up    (should have been included)
export function getAllFeedbackWithContext() {
  return db().prepare(`
    SELECT
      f.candidate_id,
      f.rating,
      f.updated_at,
      c.video_id,
      c.timestamp_sec,
      c.speaker,
      c.claim,
      c.category,
      c.novelty_score,
      c.supporting_quote,
      r.rank,
      r.why_matters,
      CASE WHEN r.rank IS NULL THEN 0 ELSE 1 END AS selected,
      e.title         AS episode_title,
      e.channel_name
    FROM feedback f
    JOIN candidates c ON c.id = f.candidate_id
    LEFT JOIN rankings r ON r.candidate_id = c.id AND r.video_id = c.video_id
    JOIN episodes e ON e.video_id = c.video_id
    ORDER BY f.updated_at DESC
  `).all();
}

export function listRecentDiscoveries({ days = 7, decision = null } = {}) {
  const params = [`-${days} days`];
  let sql = `SELECT * FROM discoveries WHERE discovered_at >= datetime('now', ?)`;
  if (decision) {
    sql += ` AND decision = ?`;
    params.push(decision);
  }
  sql += ` ORDER BY discovered_at DESC, searched_for ASC`;
  return db().prepare(sql).all(...params);
}
