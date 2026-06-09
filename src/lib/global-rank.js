// Cross-episode global ranking pass. Takes per-episode-ranked items from
// multiple episodes and produces a single ordered list, best-first.
//
// Triggered only when the brief covers ≥2 episodes — for single-episode
// briefs the per-episode rank already gives an optimal order.
//
// One Claude call (~$0.03-0.05 per run depending on number of items),
// using the rank.md system prompt as the cached base + the dedicated
// global-rank.md instructions.

import { complete, parseJsonResponse, MODELS } from './claude.js';
import { loadPrompt, loadProfile } from './config.js';
import { log } from './log.js';

// A/B knob: GLOBAL_RANK_MODEL=opus runs the cross-episode ordering pass on Opus
// instead of Sonnet. Defaults to Sonnet. This is the purest judgment pass
// (prioritizing the whole brief across episodes), so it's a strong Opus
// candidate independent of RANK_MODEL / EXTRACT_MODEL.
const GLOBAL_RANK_MODEL = process.env.GLOBAL_RANK_MODEL === 'opus' ? MODELS.OPUS : MODELS.SONNET;

export async function globalRank(items, { telemetry = {} } = {}) {
  if (!Array.isArray(items) || items.length <= 1) return items;

  const profile = loadProfile();
  const instructions = loadPrompt('global-rank');
  const system = `${instructions}\n\n---\n\n# Reader's Interest Profile\n\n${profile}`;

  // Compact payload for the model — everything it needs to judge ordering,
  // nothing it doesn't.
  const input = items.map(it => ({
    candidate_id:     it.id,
    episode_title:    it.episode_title,
    channel_name:     it.channel_name,
    published_at:     it.published_at,
    speaker:          it.speaker,
    claim:            it.claim,
    category:         it.category,
    novelty_score:    it.novelty_score,
    why_matters:      it.why_matters,
    per_episode_rank: it.rank,
  }));

  const userMsg = [
    `Items to reorder (${items.length} total across ${new Set(items.map(i => i.video_id)).size} episodes):`,
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    '',
    `Return ALL ${items.length} items reordered best-first.`,
  ].join('\n');

  let parsed;
  try {
    const { text } = await complete({
      model: GLOBAL_RANK_MODEL,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: Math.max(2048, items.length * 80),
      telemetry: { ...telemetry, stage: 'global-rank' },
    });
    parsed = parseJsonResponse(text);
    if (!Array.isArray(parsed)) throw new Error('response was not an array');
  } catch (err) {
    log.warn('global-rank failed, falling back to per-episode rank order', { err: err.message });
    return fallbackOrder(items);
  }

  // Map candidate_ids back to original item objects.
  const byId = new Map(items.map(it => [it.id, it]));
  const ordered = [];
  const seen = new Set();
  for (const entry of parsed) {
    const it = byId.get(entry.candidate_id);
    if (it && !seen.has(it.id)) {
      ordered.push(it);
      seen.add(it.id);
    }
  }
  // Defensive: append anything the model dropped, in fallback order.
  for (const it of items) {
    if (!seen.has(it.id)) ordered.push(it);
  }

  log.ok('global-rank complete', { in: items.length, out: ordered.length });
  return ordered;
}

// Stable fallback: per-episode rank asc, then most-recently-published episode first.
function fallbackOrder(items) {
  return [...items].sort((a, b) =>
    (a.rank - b.rank) ||
    String(b.published_at || '').localeCompare(String(a.published_at || ''))
  );
}
