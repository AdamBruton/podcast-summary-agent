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
      ingested_at   TEXT DEFAULT (datetime('now'))
    );

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
}

// --- Episode helpers --------------------------------------------------------

export function upsertEpisode(ep) {
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO episodes (video_id, channel_id, channel_name, title, description, published_at, duration_sec, url)
    VALUES (@video_id, @channel_id, @channel_name, @title, @description, @published_at, @duration_sec, @url)
    ON CONFLICT(video_id) DO NOTHING
  `);
  const info = stmt.run(ep);
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

export function saveRankings(video_id, rankings) {
  const d = db();
  d.prepare(`DELETE FROM rankings WHERE video_id = ?`).run(video_id);
  const stmt = d.prepare(`
    INSERT INTO rankings (video_id, candidate_id, rank, why_matters)
    VALUES (?, ?, ?, ?)
  `);
  for (const r of rankings) {
    stmt.run(video_id, r.candidate_id, r.rank, r.why_matters);
  }
}

export function getRankedBriefItems(video_id) {
  return db().prepare(`
    SELECT r.rank, r.why_matters, c.*
    FROM rankings r
    JOIN candidates c ON c.id = r.candidate_id
    WHERE r.video_id = ?
    ORDER BY r.rank
  `).all(video_id);
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

export function totalCostForRun(run_id) {
  const row = db()
    .prepare(`SELECT COALESCE(SUM(usd_cost), 0) AS total FROM cost_ledger WHERE run_id = ?`)
    .get(run_id);
  return row.total || 0;
}
