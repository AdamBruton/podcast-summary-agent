// Stage 5: Compose HTML brief.
//
// Pure function — takes episodes + their ranked items and returns one HTML
// string. The brief is one section per episode, items as bullets with
// clickable YouTube deep-links (?v=X&t=NNNs format).

import { getRankedBriefItems } from '../lib/db.js';
import { youtubeUrl } from '../lib/youtube.js';

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// YouTube auto-captions reliably mangle domain terms. We canonicalize them
// in supporting_quote (the verbatim-from-captions field) only — claims are
// model-generated and usually already clean.
// Add new entries as you spot them. Keep regexes word-boundaried.
const CANONICAL_TERMS = [
  [/\bcloud codes?\b/gi, 'Claude Code'],   // also catches the trailing 's' variant ("a lot of cloud codes is...")
  [/\btranium\b/gi,     'Trainium'],
  [/\btr[ai]nium\b/gi,  'Trainium'],
  [/\bgawatt\b/gi,      'gigawatt'],
  [/\bgawatts\b/gi,     'gigawatts'],
  [/\bgigwatt(s)?\b/gi, 'gigawatt$1'],
  [/\bmythos\b/g,       'Mythos'],
  [/\banthropic\b/g,    'Anthropic'],
  [/\bnvidia\b/g,       'NVIDIA'],
  [/\bcuda\b/g,         'CUDA'],
  [/\btsmc\b/g,         'TSMC'],
  [/\bopenai\b/gi,      'OpenAI'],
  [/\btpu(s)?\b/g,      'TPU$1'],
  [/\bgpu(s)?\b/g,      'GPU$1'],
  [/\bcve(s)?\b/g,      'CVE$1'],
];

function canonicalize(s) {
  let out = String(s ?? '');
  for (const [re, sub] of CANONICAL_TERMS) out = out.replace(re, sub);
  return out;
}

function fmtTime(sec) {
  const s = Math.floor(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`
    : `${m}:${String(r).padStart(2,'0')}`;
}

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         max-width: 720px; margin: 24px auto; padding: 0 16px; color: #111; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .date { color: #666; font-size: 13px; margin-bottom: 24px; }
  .episode { border-top: 1px solid #ddd; padding: 18px 0; }
  .episode h2 { font-size: 17px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 10px; }
  .meta a { color: #666; text-decoration: underline; }
  .item { margin: 10px 0 14px; }
  .ts { display: inline-block; background: #f3f3f3; color: #333; font-size: 11px;
        padding: 1px 6px; border-radius: 3px; text-decoration: none; font-family: ui-monospace, monospace; }
  .ts:hover { background: #e0e0e0; }
  .claim { font-weight: 600; margin-left: 6px; }
  .why { color: #555; font-size: 13px; margin: 2px 0 4px 0; font-style: italic; }
  .quote { color: #444; font-size: 13px; border-left: 3px solid #ddd; padding: 2px 0 2px 10px; margin: 4px 0; }
  .speaker { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .empty { color: #888; font-style: italic; }
  footer { color: #999; font-size: 11px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px; }
`;

// Per-day cap on total items in the brief, applied via round-robin across
// episodes: rank-1 from each ep, then rank-2 from each ep, etc., until we
// hit the cap. Guarantees each episode contributes its top pick before any
// episode's lower-ranked items appear. Single-episode runs are not capped.
const MAX_BRIEF_ITEMS = 10;

function selectItemsAcrossEpisodes(episodes, cap) {
  const byEp = episodes
    .map(ep => ({
      ep,
      items: getRankedBriefItems(ep.video_id).sort((a, b) => a.rank - b.rank),
    }))
    .filter(x => x.items.length > 0);

  // Single-episode runs: return everything (no cross-episode tension to resolve)
  if (byEp.length <= 1) return byEp;

  const keepIds = new Set();
  let level = 0, total = 0;
  while (total < cap) {
    let addedThisRound = 0;
    for (const { items } of byEp) {
      if (total >= cap) break;
      if (level < items.length) {
        keepIds.add(items[level].id);
        addedThisRound++;
        total++;
      }
    }
    if (addedThisRound === 0) break;
    level++;
  }

  return byEp
    .map(x => ({ ep: x.ep, items: x.items.filter(i => keepIds.has(i.id)) }))
    .filter(x => x.items.length > 0);
}

export function composeBrief(episodes, { date = new Date() } = {}) {
  const dateStr = date.toISOString().slice(0, 10);
  const selected = selectItemsAcrossEpisodes(episodes, MAX_BRIEF_ITEMS);
  const totalItems = selected.reduce((n, x) => n + x.items.length, 0);
  const totalCandidates = episodes.reduce(
    (n, ep) => n + getRankedBriefItems(ep.video_id).length, 0,
  );

  const sections = selected.map(({ ep, items }) => {
    const itemsHtml = items.map(it => `
      <div class="item">
        <a class="ts" href="${esc(youtubeUrl(ep.video_id, it.timestamp_sec))}">${fmtTime(it.timestamp_sec)}</a>
        <span class="claim">${esc(it.claim)}</span>
        ${it.speaker ? `<div class="speaker">${esc(it.speaker)}</div>` : ''}
        <div class="why">${esc(it.why_matters)}</div>
        ${it.supporting_quote ? `<div class="quote">${esc(canonicalize(it.supporting_quote))}</div>` : ''}
      </div>
    `).join('');

    return `
      <section class="episode">
        <h2>${esc(ep.title)}</h2>
        <div class="meta">
          ${esc(ep.channel_name)} · ${esc(ep.published_at || '')} ·
          <a href="${esc(youtubeUrl(ep.video_id))}">Watch on YouTube</a>
        </div>
        ${itemsHtml}
      </section>`;
  });

  const body = sections.length
    ? sections.join('')
    : `<div class="empty">No episodes produced ranked items today.</div>`;

  // Show the cap in the header when we actually dropped items, so it's clear
  // the brief is a curated subset of a larger ranked pool.
  const countLine = totalCandidates > totalItems
    ? `${dateStr} · top ${totalItems} of ${totalCandidates} ranked across ${selected.length} episodes`
    : `${dateStr} · ${totalItems} items across ${selected.length} episode${selected.length === 1 ? '' : 's'}`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Podcast Intel — ${dateStr}</title>
<style>${STYLE}</style></head>
<body>
  <h1>Podcast Intelligence Brief</h1>
  <div class="date">${countLine}</div>
  ${body}
  <footer>Generated by podcast-summary-agent. Edit config/profile.md to retune what surfaces here.</footer>
</body></html>`;
}
