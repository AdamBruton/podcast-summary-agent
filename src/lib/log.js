// Tiny structured logger with per-stage timing.
// Writes to stderr so stdout stays clean for piping if desired.

const COLORS = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
};

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmt(level, msg, meta) {
  const colored =
    level === 'error' ? `${COLORS.red}ERROR${COLORS.reset}` :
    level === 'warn'  ? `${COLORS.yellow}WARN ${COLORS.reset}` :
    level === 'ok'    ? `${COLORS.green}OK   ${COLORS.reset}` :
                        `${COLORS.cyan}INFO ${COLORS.reset}`;
  const metaStr = meta ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}` : '';
  return `${COLORS.dim}${ts()}${COLORS.reset} ${colored} ${msg}${metaStr}`;
}

export const log = {
  info:  (msg, meta) => console.error(fmt('info',  msg, meta)),
  ok:    (msg, meta) => console.error(fmt('ok',    msg, meta)),
  warn:  (msg, meta) => console.error(fmt('warn',  msg, meta)),
  error: (msg, meta) => console.error(fmt('error', msg, meta)),
};

// Wrap an async function with stage timing. Returns whatever fn returns.
export async function stage(name, fn) {
  const start = Date.now();
  log.info(`▶ ${name}`);
  try {
    const result = await fn();
    log.ok(`✓ ${name}`, { ms: Date.now() - start });
    return result;
  } catch (err) {
    log.error(`✗ ${name}`, { ms: Date.now() - start, err: err.message });
    throw err;
  }
}
