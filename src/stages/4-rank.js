// Stage 4: Rank candidates against the reader's interest profile.
//
// The profile is part of the system block (cached) — same profile across
// every episode in the run, so cache hits cover all rank calls after the first.

import { loadProfile, loadPrompt } from '../lib/config.js';
import { complete, parseJsonResponse, MODELS } from '../lib/claude.js';
import { getCandidates, saveRankings, setEpisodeStatus } from '../lib/db.js';
import { log } from '../lib/log.js';

const SYSTEM = `${loadPrompt('rank')}\n\n--- READER INTEREST PROFILE ---\n\n${loadProfile()}`;

export async function rankEpisode(episode, { run_id }) {
  const candidates = getCandidates(episode.video_id);
  if (candidates.length === 0) {
    log.warn('no candidates to rank', { video_id: episode.video_id });
    return [];
  }

  const userMsg = [
    `Episode: ${episode.title}`,
    `Channel: ${episode.channel_name}`,
    `Published: ${episode.published_at}`,
    '',
    '--- CANDIDATES ---',
    JSON.stringify(
      candidates.map(c => ({
        id:               c.id,
        timestamp_sec:    c.timestamp_sec,
        speaker:          c.speaker,
        claim:            c.claim,
        category:         c.category,
        novelty_score:    c.novelty_score,
        supporting_quote: c.supporting_quote,
      })),
      null, 2,
    ),
  ].join('\n');

  const { text } = await complete({
    model: MODELS.SONNET,
    system: SYSTEM,
    max_tokens: 2048,
    messages: [{ role: 'user', content: userMsg }],
    telemetry: { run_id, video_id: episode.video_id, stage: 'rank' },
  });

  let rankings;
  try {
    rankings = parseJsonResponse(text);
  } catch (err) {
    log.error('rank: JSON parse failed', { video_id: episode.video_id, err: err.message });
    return [];
  }
  if (!Array.isArray(rankings)) {
    log.error('rank: response was not an array', { video_id: episode.video_id });
    return [];
  }

  // Validate ids for both shapes (single: candidate_id; bundle:
  // candidate_ids[]). Bundles with any unknown ids keep only the known ones;
  // a bundle reduced to fewer than 2 valid ids gets demoted to a single.
  const validIds = new Set(candidates.map(c => c.id));
  rankings = rankings
    .map(r => {
      if (Array.isArray(r.candidate_ids) && r.candidate_ids.length) {
        const filtered = r.candidate_ids.filter(id => validIds.has(id));
        if (filtered.length === 0) return null;
        if (filtered.length === 1) {
          const { candidate_ids, label, ...rest } = r;
          return { ...rest, candidate_id: filtered[0] };
        }
        return { ...r, candidate_ids: filtered };
      }
      return validIds.has(r.candidate_id) ? r : null;
    })
    .filter(Boolean);

  const bundleCount = rankings.filter(r => Array.isArray(r.candidate_ids)).length;
  saveRankings(episode.video_id, rankings);
  setEpisodeStatus(episode.video_id, 'ranked');
  log.ok('ranked', {
    video_id: episode.video_id, picked: rankings.length, bundles: bundleCount,
  });
  return rankings;
}
