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

export async function deliver(html, { dryRun, episodes, date = new Date() }) {
  const dateStr = date.toISOString().slice(0, 10);

  if (dryRun) {
    const file = path.join(BRIEF_DIR, `${dateStr}.html`);
    fs.writeFileSync(file, html, 'utf8');
    log.ok('dry-run brief written', { path: file });
    return { delivered: false, path: file };
  }

  const { SENDGRID_API_KEY, SENDGRID_FROM, SENDGRID_TO } =
    requireEnv('SENDGRID_API_KEY', 'SENDGRID_FROM', 'SENDGRID_TO');
  sgMail.setApiKey(SENDGRID_API_KEY);
  await sgMail.send({
    to: SENDGRID_TO,
    from: SENDGRID_FROM,
    subject: `Podcast Intel — ${dateStr}`,
    html,
  });
  for (const ep of episodes) markDelivered(ep.video_id);
  log.ok('email delivered', { to: SENDGRID_TO });
  return { delivered: true };
}
