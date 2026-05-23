// Stage 3: Extract candidate moments via Claude.
//
// Input: an episode + its transcript.
// Output: candidate rows persisted via db.saveCandidates.
//
// The extract prompt is the cached system block — stable across all
// episodes in a run, so we get cache hits after the first call.
//
// Long transcripts (e.g. 3hr Acquired) are chunked. Each chunk reuses the
// same cached system prompt; we de-dup near-identical claims at the end.

import { loadPrompt } from '../lib/config.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import { getTranscript, saveCandidates, setEpisodeStatus } from '../lib/db.js';
import { verifyNumericFidelity } from '../lib/number-check.js';
import { log } from '../lib/log.js';

const SYSTEM = loadPrompt('extract');

// Chunk transcripts that would otherwise dominate the context window.
// ~240k chars ≈ 60k tokens, comfortable inside Sonnet's 200k window with
// room for the system prompt + response.
const MAX_CHUNK_CHARS  = 240_000;
const CHUNK_OVERLAP    = 8;  // cues re-included at the head of each chunk

export async function extractEpisode(episode, { run_id }) {
  const t = getTranscript(episode.video_id);
  if (!t) {
    log.warn('no transcript, skipping extract', { video_id: episode.video_id });
    return [];
  }

  const chunks = chunkCues(t.cues, MAX_CHUNK_CHARS);
  if (chunks.length > 1) {
    log.info('chunking long transcript', { video_id: episode.video_id, chunks: chunks.length });
  }

  const allCandidates = [];
  for (let i = 0; i < chunks.length; i++) {
    const transcriptText = chunks[i]
      .map(c => `[${Math.floor(c.start)}s] ${c.text}`)
      .join('\n');

    const userMsg = [
      `Episode: ${episode.title}`,
      `Channel: ${episode.channel_name}`,
      `Published: ${episode.published_at}`,
      `Duration: ${Math.round((episode.duration_sec || 0) / 60)} min`,
      chunks.length > 1 ? `Chunk: ${i + 1} of ${chunks.length}` : null,
      episode.description ? `Description: ${episode.description.slice(0, 500)}` : null,
      '',
      '--- TRANSCRIPT ---',
      transcriptText,
    ].filter(Boolean).join('\n');

    const { text } = await complete({
      model: MODELS.SONNET,
      system: SYSTEM,
      max_tokens: 8192,
      messages: [{ role: 'user', content: userMsg }],
      telemetry: { run_id, video_id: episode.video_id, stage: 'extract' },
    });

    let candidates;
    try {
      candidates = parseJsonResponse(text);
    } catch (err) {
      log.warn('extract chunk: JSON parse failed, skipping chunk', {
        video_id: episode.video_id, chunk: i + 1, err: err.message,
      });
      continue;
    }
    if (Array.isArray(candidates)) allCandidates.push(...candidates);
  }

  // Defense-in-depth: drop any candidate whose claim contains a number not
  // present in its own supporting_quote. Catches paraphrase-hallucinations
  // like the Krishna $75B → $7.5B regression regardless of prompt wording.
  const numberOk = [];
  let droppedForNumbers = 0;
  for (const c of allCandidates) {
    const v = verifyNumericFidelity(c.claim, c.supporting_quote);
    if (!v.ok) {
      droppedForNumbers++;
      log.warn('extract: dropping candidate (number not in supporting_quote)', {
        video_id: episode.video_id,
        missing: v.missing,
        claim: (c.claim || '').slice(0, 80),
      });
      continue;
    }
    numberOk.push(c);
  }

  const deduped = dedupeCandidates(numberOk);
  const ids = saveCandidates(episode.video_id, deduped);
  setEpisodeStatus(episode.video_id, 'extracted');
  log.ok('extracted', {
    video_id:        episode.video_id,
    n:               deduped.length,
    raw:             allCandidates.length,
    dropped_numeric: droppedForNumbers,
  });
  return ids;
}

// Split cues into chunks bounded by total char count of the rendered transcript.
// Each new chunk re-includes the last CHUNK_OVERLAP cues from the prior one so
// claims that span a boundary don't fall through.
function chunkCues(cues, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const c of cues) {
    const lineLen = (c.text?.length || 0) + 12; // +overhead for [Xs] prefix
    if (chars + lineLen > maxChars && current.length > 0) {
      chunks.push(current);
      current = current.slice(-CHUNK_OVERLAP);
      chars = current.reduce((n, x) => n + (x.text?.length || 0) + 12, 0);
    }
    current.push(c);
    chars += lineLen;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Same-timestamp-window + prefix-match dedupe. Cheap and good enough.
function dedupeCandidates(items) {
  const out = [];
  for (const c of items) {
    const dup = out.find(o =>
      Math.abs((o.timestamp_sec || 0) - (c.timestamp_sec || 0)) < 10 &&
      (o.claim || '').slice(0, 50) === (c.claim || '').slice(0, 50)
    );
    if (!dup) out.push(c);
  }
  return out;
}
