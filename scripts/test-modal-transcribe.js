// Standalone smoke test for the Node-side Modal transcription client
// (src/lib/modal-transcribe.js) — Phase 3. Submits an audio URL to the deployed
// WhisperX-on-Modal endpoint and prints the resulting cues. Does NOT touch the
// DB or the pipeline; it just exercises the HTTP client end-to-end.
//
// Requires MODAL_TRANSCRIBE_URL + MODAL_TRANSCRIBE_SECRET in the environment
// (they live in .env locally). Usage:
//
//   node scripts/test-modal-transcribe.js [<audio_url>] [<clip_seconds>]
//
// With no args it transcribes a 300s clip of a known a16z episode (cheap-ish).
// Pass a real enclosure URL and omit clip_seconds for a full-episode run
// (~14 min of GPU; be patient — the client polls until done).
//
// NOTE: don't drop the default clip below ~120s. whisperx's alignment step
// raises `UnboundLocalError: language` on very short (e.g. 60s) audio — a
// whisperx bug, not ours. Production transcribes full episodes, so it never
// hits this; only this smoke test (with a tiny clip) can.

import '../src/lib/config.js';                  // loads .env
import { fetchTranscriptFromModal } from '../src/lib/modal-transcribe.js';

const DEFAULT_AUDIO_URL =
  'https://mgln.ai/e/1344/afp-848985-injected.calisto.simplecastaudio.com/' +
  '3f86df7b-51c6-4101-88a2-550dba782de8/episodes/' +
  '0a48e90e-2555-4245-b3b9-3957c98ab2c4/audio/128/default.mp3' +
  '?aid=rss_feed&feed=JGE3yC0V';

const audioUrl = process.argv[2] || DEFAULT_AUDIO_URL;
const clipArg = process.argv[3];
// Default to a 60s clip ONLY when using the built-in sample; a user-supplied
// URL with no clip arg means "transcribe the whole thing".
const clipSeconds = clipArg != null
  ? Number(clipArg)
  : (process.argv[2] ? undefined : 300);

console.log('Submitting to Modal worker...');
console.log('  audio_url   :', audioUrl);
console.log('  clip_seconds:', clipSeconds ?? '(full episode)');
console.log('  (polling every 15s — this can take several minutes)\n');

const t0 = Date.now();
const result = await fetchTranscriptFromModal(audioUrl, { clipSeconds });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (!result) {
  console.error(`\nNo transcript returned (worker produced no usable cues). [${elapsed}s]`);
  process.exit(1);
}

console.log(`\n--- transcript (${elapsed}s wall clock) ---`);
console.log(`language: ${result.language} | cues: ${result.cues.length} | ` +
            `speakers: ${result.speakers.join(', ') || '(none)'}\n`);
for (const c of result.cues.slice(0, 20)) {
  const spk = c.speaker || '?';
  console.log(`  [${c.start.toFixed(1).padStart(7)}–${c.end.toFixed(1).padStart(7)}] (${spk})  ${c.text}`);
}
if (result.cues.length > 20) {
  console.log(`  ... +${result.cues.length - 20} more cues`);
}
