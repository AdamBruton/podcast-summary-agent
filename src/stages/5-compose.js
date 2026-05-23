// Stage 5: Compose HTML brief.
//
// Async — takes episodes + their per-episode rankings, calls the global-rank
// stage for multi-episode briefs to produce a single cross-episode ordering,
// and renders the brief as one flat ordinally-numbered list. Items have
// clickable YouTube deep-links (?v=X&t=NNNs format).
//
// No item cap — the reader scans top-down and stops when they're done. The
// global rank ensures the highest-signal items are first regardless of which
// episode they came from.

import { getRankedBriefItems } from '../lib/db.js';
import { youtubeUrl } from '../lib/youtube.js';
import { globalRank } from '../lib/global-rank.js';

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

// Email-safe styling. We avoid CSS Grid / Flexbox (Gmail mobile and some
// clients strip them inconsistently) and use a per-item <table> for the
// rank+content layout — that renders identically everywhere, including
// Gmail mobile and Outlook desktop.
const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         max-width: 720px; margin: 24px auto; padding: 0 16px; color: #111; line-height: 1.55; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .date { color: #666; font-size: 13px; margin-bottom: 24px; }
  table.item { width: 100%; border-collapse: collapse; border-top: 1px solid #eee; }
  table.item.first { border-top: 1px solid #ddd; }
  td.rank-cell { width: 40px; vertical-align: top; text-align: right; padding: 18px 12px 0 0;
                 color: #999; font-size: 22px; font-weight: 700;
                 font-variant-numeric: tabular-nums; }
  td.body-cell { vertical-align: top; padding: 16px 0; }
  .head { font-size: 12px; color: #666; margin-bottom: 4px; }
  .head a { color: #666; text-decoration: none; }
  .head .show { font-weight: 500; }
  .ts { display: inline-block; background: #f3f3f3; color: #333; font-size: 11px;
        padding: 1px 6px; border-radius: 3px; text-decoration: none;
        font-family: ui-monospace, "SF Mono", Consolas, monospace; margin-right: 6px; }
  .ts:hover { background: #e0e0e0; }
  .claim { font-weight: 600; font-size: 15px; margin: 2px 0; }
  .speaker { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
             margin-top: 2px; }
  .why { color: #555; font-size: 13px; margin: 4px 0 6px 0; font-style: italic; }
  .quote { color: #444; font-size: 13px; border-left: 3px solid #ddd;
           padding: 2px 0 2px 10px; margin: 4px 0 0 0; }
  .empty { color: #888; font-style: italic; }
  footer { color: #999; font-size: 11px; margin-top: 32px; border-top: 1px solid #eee;
           padding-top: 12px; text-align: center; }
`;

// Gather every per-episode-ranked item, tagged with the episode context the
// flat renderer needs.
function gatherAllItems(episodes) {
  const out = [];
  for (const ep of episodes) {
    for (const it of getRankedBriefItems(ep.video_id)) {
      out.push({
        ...it,
        video_id:      ep.video_id,
        episode_title: ep.title,
        channel_name:  ep.channel_name,
        published_at:  ep.published_at,
      });
    }
  }
  return out;
}

function renderItem(it, rank, isFirst) {
  const ts = `<a class="ts" href="${esc(youtubeUrl(it.video_id, it.timestamp_sec))}">${fmtTime(it.timestamp_sec)}</a>`;
  const show = `<a href="${esc(youtubeUrl(it.video_id))}"><span class="show">${esc(it.channel_name)}</span> — ${esc(it.episode_title)}</a>`;
  return `
    <table class="item${isFirst ? ' first' : ''}" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="rank-cell">${rank}</td>
        <td class="body-cell">
          <div class="head">${ts}${show}</div>
          <div class="claim">${esc(it.claim)}</div>
          ${it.speaker ? `<div class="speaker">${esc(it.speaker)}</div>` : ''}
          <div class="why">${esc(it.why_matters)}</div>
          ${it.supporting_quote ? `<div class="quote">${esc(canonicalize(it.supporting_quote))}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

export async function composeBrief(episodes, { date = new Date(), telemetry = {} } = {}) {
  const dateStr = date.toISOString().slice(0, 10);
  const items = gatherAllItems(episodes);

  if (items.length === 0) {
    return wrapHtml(dateStr, `${dateStr} · no items to brief today`,
      `<div class="empty">No episodes produced ranked items today.</div>`);
  }

  // For a single episode the per-episode rank is already the optimal order;
  // for multi-episode we run the cross-episode global rank.
  const episodeCount = new Set(items.map(i => i.video_id)).size;
  let ordered;
  if (episodeCount === 1) {
    ordered = [...items].sort((a, b) => a.rank - b.rank);
  } else {
    ordered = await globalRank(items, { telemetry });
  }

  const itemsHtml = ordered.map((it, i) => renderItem(it, i + 1, i === 0)).join('');
  const headerLine = `${dateStr} · ${ordered.length} items across ${episodeCount} episode${episodeCount === 1 ? '' : 's'} · ranked top-down`;
  return wrapHtml(dateStr, headerLine, itemsHtml);
}

function wrapHtml(dateStr, headerLine, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Podcast Intel — ${dateStr}</title>
<style>${STYLE}</style></head>
<body>
  <h1>Podcast Intelligence Brief</h1>
  <div class="date">${headerLine}</div>
  ${body}
  <footer>Generated by podcast-summary-agent. Edit config/profile.md to retune ranking.</footer>
</body></html>`;
}
