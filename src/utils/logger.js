/**
 * Logger minimal tanpa dependency.
 *
 * Format: [2026-09-25T10:00:00.000Z] [INFO ] [live] pesan { detail }
 *
 * Semua nilai yang dilewatkan sebagai `meta` akan melewati redactor, sehingga
 * webhook URL / token tidak pernah tercetak utuh ke stdout maupun ke file log
 * PM2. Lihat `redactSecrets()`.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

/** @param {string} level */
export function setLogLevel(level) {
  const resolved = LEVELS[String(level).toLowerCase()];
  currentLevel = resolved ?? LEVELS.info;
}

/**
 * Menyamarkan bagian rahasia dari sebuah string.
 * Discord webhook URL berbentuk .../webhooks/<id>/<token> — token-nya yang
 * harus disembunyikan, id boleh ditampilkan sebagian agar tetap bisa dibedakan.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecrets(value) {
  if (typeof value === 'string') {
    return value
      .replace(
        /(https:\/\/[^\s"']*?\/api\/webhooks\/)(\d{1,6})\d*\/[\w-]+/gi,
        (_m, prefix, idHead) => `${prefix}${idHead}***/***`,
      )
      .replace(/([?&](?:access_token|refresh_token|client_secret)=)[^&\s]+/gi, '$1***');
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /secret|token|password|webhook/i.test(k) && typeof v === 'string'
        ? '***redacted***'
        : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function emit(level, scope, message, meta) {
  if (LEVELS[level] < currentLevel) return;
  const line =
    `[${new Date().toISOString()}] ` +
    `[${level.toUpperCase().padEnd(5)}] ` +
    `[${scope}] ` +
    String(redactSecrets(message));

  let suffix = '';
  if (meta !== undefined) {
    try {
      suffix = ` ${JSON.stringify(redactSecrets(meta))}`;
    } catch {
      suffix = ' [meta tidak bisa diserialisasi]';
    }
  }

  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(line + suffix);
}

/**
 * Membuat logger yang terikat pada satu scope, mis. `createLogger('live')`.
 * @param {string} scope
 */
export function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('app');
