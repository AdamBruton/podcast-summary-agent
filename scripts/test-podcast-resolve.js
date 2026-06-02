// Smoke-test the ad-hoc podcast resolver (no DB, no transcription).
//   node scripts/test-podcast-resolve.js <url> [<url> ...]
// With no args, runs a couple of built-in cases (a public RSS feed + a page).
// Prints the resolved episode row so you can eyeball audio_url / title / show.

import { resolvePodcastEpisode } from '../src/lib/podcast-resolve.js';

const DEFAULTS = [
  'https://feeds.simplecast.com/4T39_jAj',   // a public RSS feed (latest item)
];

const urls = process.argv.slice(2);
const targets = urls.length ? urls : DEFAULTS;

for (const url of targets) {
  process.stdout.write(`\n→ ${url}\n`);
  try {
    const ep = await resolvePodcastEpisode(url);
    console.log(JSON.stringify({
      video_id: ep.video_id,
      title: ep.title,
      channel_name: ep.channel_name,
      audio_url: ep.audio_url,
      episode_page_url: ep.episode_page_url,
      published_at: ep.published_at,
    }, null, 2));
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
}
