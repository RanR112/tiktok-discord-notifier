/**
 * Tipe error yang dipakai lintas modul supaya pemanggil bisa membedakan
 * "gagal sementara, boleh dicoba lagi" dari "gagal permanen, jangan diulang".
 */

/** Error konfigurasi. Selalu fatal: aplikasi berhenti dengan pesan jelas. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Error saat berkomunikasi lewat HTTP. */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, retryAfterMs?: number, body?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
}

/**
 * Sumber data TikTok tidak bisa dibaca (diblokir WAF, format berubah, dll).
 * Bukan bug aplikasi — monitor cukup melewati siklus ini dan mencoba lagi nanti.
 */
export class ProviderUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, reason?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderUnavailableError';
    this.reason = options.reason ?? 'unknown';
  }
}
