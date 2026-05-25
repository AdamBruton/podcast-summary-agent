// Stage 6: Deliver.
//
// --dry-run mode: writes HTML to data/briefs/YYYY-MM-DD.html and returns the path.
// real mode: sends via SendGrid using SENDGRID_API_KEY/FROM/TO env vars.

import fs from 'node:fs';
import path from 'node:path';
import sgMail from '@sendgrid/mail';
import { BRIEF_DIR, requireEnv } from '../lib/config.js';
import { markDelivered } from '../lib/db.js';
import { log } from '../lib/log.js';

// `markDeliveredOnSend` (default true): after a successful send, mark the
// episodes as 'delivered' so they don't reappear in future daily runs. Set
// to false for ad-hoc URL sends from the web UI, where the user wants the
// episode to ALSO be included in tomorrow's daily roundup.
export async function deliver(html, { dryRun, episodes, date = new Date(), markDeliveredOnSend = true }) {
  const dateStr = date.toISOString().slice(0, 10);

  if (dryRun) {
    const suffix = episodes.length === 1 ? `-${episodes[0].video_id}` : '';
    const file = path.join(BRIEF_DIR, `${dateStr}${suffix}.html`);
    fs.writeFileSync(file, html, 'utf8');
    log.ok('dry-run brief written', { path: file });
    return { delivered: false, path: file };
  }

  // Don't send empty briefs. A real-mode call with zero episodes means
  // upstream stages couldn't process anything (skipped, no captions, etc.).
  // Silently sending a "no items today" email creates false-success noise
  // — better to surface the no-op to the caller so the ad-hoc UI path
  // can show a real error and the daily run logs it.
  if (!episodes.length) {
    log.info('no episodes to brief; skipping send');
    return { delivered: false, empty: true };
  }

  const { SENDGRID_API_KEY, SENDGRID_FROM, SENDGRID_TO } =
    requireEnv('SENDGRID_API_KEY', 'SENDGRID_FROM', 'SENDGRID_TO');
  sgMail.setApiKey(SENDGRID_API_KEY);

  // Smarter subject when there's exactly one episode — the title shows up
  // in the inbox preview instead of a generic date.
  const subject = episodes.length === 1 && episodes[0].title
    ? `Podcast Intel: ${episodes[0].title}`
    : `Podcast Intel — ${dateStr}`;

  await sgMail.send({
    to: SENDGRID_TO,
    from: SENDGRID_FROM,
    subject,
    html,
  });
  if (markDeliveredOnSend) {
    for (const ep of episodes) markDelivered(ep.video_id);
  }
  log.ok('email delivered', { to: SENDGRID_TO, markedDelivered: markDeliveredOnSend });
  return { delivered: true };
}
