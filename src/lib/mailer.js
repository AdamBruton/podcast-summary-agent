// Email transport. A single Resend-backed sender shared by the daily brief
// (6-deliver.js) and the weekly DB backup (backup.js). Centralizing the
// provider here means a future swap touches exactly one file — the call sites
// only know `sendEmail(...)`, not who delivers it.
//
// Env:
//   RESEND_API_KEY  the re_... key from the Resend dashboard
//   MAIL_FROM       "Display Name <addr@your-domain>"; the domain MUST be
//                   verified in Resend or the API rejects the send (403/400)
//   MAIL_TO         recipient address
//
// (Provider-neutral MAIL_FROM/MAIL_TO names: a later swap won't need renaming.)

import { Resend } from 'resend';

// Lazily construct the client so merely importing this module never throws when
// the key is absent — backup.js soft-skips email when unconfigured, and only an
// actual send needs the key.
let client = null;
function resend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  if (!client) client = new Resend(key);
  return client;
}

// True when all three email vars are present. backup.js uses this to decide
// whether to attempt the weekly off-site send vs. keeping an on-volume copy only.
export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM && process.env.MAIL_TO);
}

// Send one email via Resend. `attachments` (optional) is an array of
// `{ filename, content }` where `content` is a Buffer — Resend base64-encodes
// it internally, so callers pass raw bytes (no manual .toString('base64')).
// Throws on a missing address config or an API-level error.
export async function sendEmail({ subject, html, text, attachments }) {
  const from = process.env.MAIL_FROM;
  const to = process.env.MAIL_TO;
  if (!from || !to) throw new Error('MAIL_FROM / MAIL_TO not set');

  const payload = { from, to, subject };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (attachments?.length) payload.attachments = attachments;

  // Resend's SDK resolves (not rejects) on API errors — it returns
  // `{ data, error }`. Surface the error verbatim so callers log a real reason.
  const { data, error } = await resend().emails.send(payload);
  if (error) {
    throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
  }
  return { id: data?.id, to };
}
