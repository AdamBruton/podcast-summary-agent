// Manual on-demand DB backup. The daily cron already runs this via the
// pipeline; use this when you want a snapshot RIGHT NOW (e.g. before a risky
// CLI operation).
//
// Usage:
//   node scripts/backup-db.js           # local snapshot only
//   node scripts/backup-db.js --email   # also email a copy if SendGrid is set

import { backupDatabase } from '../src/lib/backup.js';

const emailIfDue = process.argv.includes('--email');

const result = await backupDatabase({ emailIfDue });
console.log(`backup written: ${result.path} (${result.bytes} bytes)`);
