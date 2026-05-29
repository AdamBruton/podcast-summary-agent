// Standalone podcast ingestion script.
//
// Polls every enabled podcast in config/sources.yaml, parses each RSS feed,
// and inserts new episode rows (medium='podcast', status='new') into the DB.
// Existing rows are skipped via upsertEpisode's ON CONFLICT DO NOTHING.
//
// Phase 1 is intentionally NOT wired into runDaily — running this manually
// surfaces RSS issues without involving Modal/WhisperX (Phase 2). After
// Phase 2 lands, the daily run will call the same pollPodcasts() under the
// hood and this script becomes either redundant or a debugging aid.
//
// Usage:  node scripts/ingest-podcasts.js [--since-days N] [--limit N]
//   --since-days  filter episodes older than N days (default 30)
//   --limit       max items per feed to consider (default 25)

import { loadSources } from '../src/lib/config.js';
import { pollPodcasts } from '../src/lib/rss.js';
import { upsertEpisode, getEpisode } from '../src/lib/db.js';
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
  const { podcasts } = loadSources();
  if (!podcasts.length) {
    log.warn('no podcasts configured in sources.yaml');
    return;
  }

  const sinceDate = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10);
  log.info('polling podcasts', { count: podcasts.length, sinceDate, limit });

  const candidates = await pollPodcasts(podcasts, { limit });

  let inserted = 0;
  let skippedOld = 0;
  let skippedExisting = 0;
  const perPodcast = {};
  for (const ep of candidates) {
    perPodcast[ep.channel_name] ||= { inserted: 0, skippedOld: 0, skippedExisting: 0 };
    if (ep.published_at && ep.published_at.slice(0, 10) < sinceDate) {
      skippedOld++;
      perPodcast[ep.channel_name].skippedOld++;
      continue;
    }
    if (getEpisode(ep.video_id)) {
      skippedExisting++;
      perPodcast[ep.channel_name].skippedExisting++;
      continue;
    }
    const isNew = upsertEpisode(ep);
    if (isNew) {
      inserted++;
      perPodcast[ep.channel_name].inserted++;
      log.ok('new', {
        podcast: ep.channel_name,
        title: ep.title.slice(0, 60),
        published: ep.published_at?.slice(0, 10),
      });
    }
  }

  log.info('done', { inserted, skipped_old: skippedOld, skipped_existing: skippedExisting });
  for (const [name, counts] of Object.entries(perPodcast)) {
    log.info(`  ${name}`, counts);
  }
}

main().catch(err => {
  log.error('fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
