// Standalone podcast ingestion — thin wrapper over ingestPodcastsDaily().
//
// As of Phase 4, podcast ingestion is wired into runDaily (pipeline.js calls
// the same ingestPodcastsDaily() this script does). This script is kept as a
// debugging aid: poll the feeds + insert new rows WITHOUT running the rest of
// the pipeline (transcribe/extract/rank/compose), so you can surface RSS issues
// in isolation.
//
// Usage:  node scripts/ingest-podcasts.js [--since-days N] [--limit N]
//   --since-days  ignore episodes older than N days (default 30 here; the daily
//                 run uses its own lookbackDays, default 2)
//   --limit       max items per feed to consider (default 25)

import { ingestPodcastsDaily } from '../src/stages/1-ingest.js';
import { log } from '../src/lib/log.js';

function parseArgs(argv) {
  const args = { sinceDays: 30, limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since-days') args.sinceDays = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const { sinceDays, limit } = parseArgs(process.argv.slice(2));
  log.info('polling podcasts (standalone)', { sinceDays, limit });
  const inserted = await ingestPodcastsDaily({ lookbackDays: sinceDays, limit });
  log.info('done', { inserted: inserted.length });
}

main().catch(err => {
  log.error('fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
