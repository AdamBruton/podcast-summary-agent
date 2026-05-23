// Temp diagnostic: dump extracted candidates + raw transcript around a
// timestamp, so we can tell whether a recall miss is at extract or rank.
import { db, getTranscript } from '../src/lib/db.js';

const vid = process.argv[2] || 'Hrbq66XqtCo';
const center = Number(process.argv[3] || 4517); // 1:15:17
const half = 300; // ±5 min

const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;

const cands = db()
  .prepare(`SELECT id, timestamp_sec, category, novelty_score, claim
            FROM candidates
            WHERE video_id = ? AND timestamp_sec BETWEEN ? AND ?
            ORDER BY timestamp_sec`)
  .all(vid, center - half, center + half);

console.log(`\n=== CANDIDATES extracted in ${fmt(center-half)} – ${fmt(center+half)} ===`);
for (const c of cands) {
  console.log(`[${fmt(c.timestamp_sec)}] id=${c.id} ${c.category} nov=${c.novelty_score}\n    ${c.claim}`);
}
console.log(`(${cands.length} candidates in window)\n`);

const t = getTranscript(vid);
const cues = t.cues.filter(c => c.start >= center - 180 && c.start <= center + 240);
console.log(`=== TRANSCRIPT cues ${fmt(center-180)} – ${fmt(center+240)} ===`);
for (const c of cues) {
  console.log(`[${fmt(c.start)}] ${c.text}`);
}
