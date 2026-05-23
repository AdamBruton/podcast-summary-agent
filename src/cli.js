#!/usr/bin/env node
// CLI entry. Thin wrapper over pipeline.js — see `--help` for usage.

import { parseArgs } from 'node:util';
import { runEpisode, runDaily } from './pipeline.js';
import { log } from './lib/log.js';

const HELP = `
podcast-summary-agent

Usage:
  npm run brief                                  # daily run, send email
  npm run brief:dry                              # daily run, write HTML to disk only
  node src/cli.js --episode "<youtube-url>" [--dry-run]
  node src/cli.js [--dry-run] [--lookback <days>]

Options:
  --episode <url>     Process a single YouTube URL (skips daily ingest).
                      Useful for testing or one-off briefs.
  --dry-run           Write the HTML brief to data/briefs/YYYY-MM-DD.html
                      instead of sending via SendGrid.
  --lookback <days>   How many days back to consider as "new" for daily run.
                      Default: 2.
  --max-usd <amount>  Abort the run once total Claude cost exceeds this many
                      USD. Daily mode composes a brief from episodes completed
                      before the trip; single-episode mode just exits.
                      Overrides MAX_USD_PER_RUN env. Default: no limit.
  --help, -h          Show this message.

Env vars (see .env.example):
  ANTHROPIC_API_KEY   required
  GROQ_API_KEY        optional, for Whisper fallback when YouTube has no captions
  YT_COOKIES_FILE     optional, path to cookies.txt — needed on CI/cloud IPs
                      where YouTube 403s anonymous requests
  MAX_USD_PER_RUN     optional, default budget for runs (see --max-usd)
  SENDGRID_API_KEY    required when not --dry-run
  SENDGRID_FROM       required when not --dry-run
  SENDGRID_TO         required when not --dry-run
`;

let parsed;
try {
  parsed = parseArgs({
    options: {
      'dry-run':  { type: 'boolean', default: false },
      'episode':  { type: 'string' },
      'lookback': { type: 'string', default: '2' },
      'max-usd':  { type: 'string' },
      'help':     { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error(HELP);
  process.exit(2);
}

const { values } = parsed;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const dryRun = values['dry-run'];

let maxUsd = null;
if (values['max-usd'] != null) {
  maxUsd = Number(values['max-usd']);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    console.error(`Error: --max-usd must be a non-negative number, got: ${values['max-usd']}`);
    process.exit(2);
  }
}

try {
  if (values.episode) {
    const result = await runEpisode({ url: values.episode, dryRun, maxUsd });
    if (result?.path) log.ok(`brief at: ${result.path}`);
  } else {
    const lookbackDays = Number(values.lookback);
    if (!Number.isFinite(lookbackDays) || lookbackDays < 0) {
      throw new Error(`--lookback must be a non-negative number, got: ${values.lookback}`);
    }
    const result = await runDaily({ dryRun, lookbackDays, maxUsd });
    if (result?.path) log.ok(`brief at: ${result.path}`);
  }
} catch (err) {
  log.error('pipeline failed', { err: err.message });
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
