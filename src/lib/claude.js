// Thin wrapper around the Anthropic SDK with:
//   - prompt caching on the system block (long, stable profile + instructions)
//   - token usage logged to the cost ledger
//   - per-call $ cost computed from Sonnet 4.6 published rates
//
// Migration note: when bumping models, update MODEL_PRICING below.

import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from './config.js';
import { recordCost } from './db.js';
import { log } from './log.js';

export const MODELS = {
  SONNET: 'claude-sonnet-4-6',
  OPUS:   'claude-opus-4-8',
};

// USD per million tokens. Sonnet 4.6 rates as of model release.
// NOTE: the Opus row below is BEST-KNOWN, not confirmed — verify current Opus
// 4.x rates before trusting its cost telemetry, then correct here. calcCost
// returns 0 for any model missing from this table, so a wrong row only skews
// the $ ledger, never the actual API call.
const MODEL_PRICING = {
  'claude-sonnet-4-6': {
    input:        3.00,
    output:      15.00,
    cache_read:   0.30,
    cache_write_5m: 3.75,
  },
  'claude-opus-4-8': {
    input:        5.00,
    output:      25.00,
    cache_read:   0.50,
    cache_write_5m: 6.25,
  },
};

let _client = null;
function client() {
  if (_client) return _client;
  const { ANTHROPIC_API_KEY } = requireEnv('ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _client;
}

function calcCost(model, usage) {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (input      * p.input          / 1_000_000) +
    (output     * p.output         / 1_000_000) +
    (cacheRead  * p.cache_read     / 1_000_000) +
    (cacheWrite * p.cache_write_5m / 1_000_000)
  );
}

/**
 * Make a Claude call with prompt caching on the system block.
 *
 * @param {Object} opts
 * @param {string} opts.model           Model ID (default Sonnet)
 * @param {string} opts.system          System prompt (cached)
 * @param {Array}  opts.messages        Standard messages array
 * @param {number} opts.max_tokens      (default 4096)
 * @param {Object} opts.telemetry       { run_id, video_id, stage } for cost ledger
 * @returns {Promise<{text: string, usage: object, cost_usd: number, raw: object}>}
 */
export async function complete({
  model = MODELS.SONNET,
  system,
  messages,
  max_tokens = 4096,
  telemetry = {},
}) {
  const c = client();
  const resp = await c.messages.create({
    model,
    max_tokens,
    system: system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : undefined,
    messages,
  });

  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const cost_usd = calcCost(model, resp.usage);

  if (telemetry.run_id) {
    recordCost({
      run_id:        telemetry.run_id,
      video_id:      telemetry.video_id || null,
      stage:         telemetry.stage || 'unknown',
      model,
      input_tokens:  resp.usage.input_tokens || 0,
      cached_tokens: (resp.usage.cache_read_input_tokens || 0)
                   + (resp.usage.cache_creation_input_tokens || 0),
      output_tokens: resp.usage.output_tokens || 0,
      usd_cost:      cost_usd,
    });
  }

  log.info(`claude/${telemetry.stage || '?'}`, {
    in: resp.usage.input_tokens,
    cache_r: resp.usage.cache_read_input_tokens || 0,
    cache_w: resp.usage.cache_creation_input_tokens || 0,
    out: resp.usage.output_tokens,
    usd: cost_usd.toFixed(4),
  });

  return { text, usage: resp.usage, cost_usd, raw: resp };
}

// Best-effort extract a JSON object/array from a model response that may
// include surrounding prose or markdown fences.
export function parseJsonResponse(text) {
  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);
  // Otherwise try to find the first [ or { and parse from there.
  const start = text.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON found in model response');
  return JSON.parse(text.slice(start));
}
