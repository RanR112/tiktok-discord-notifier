/**
 * Lapisan HTTP bersama: timeout, retry dengan exponential backoff + jitter,
 * dan penghormatan terhadap header `Retry-After` saat kena HTTP 429.
 *
 * Aturan retry:
 *   - Network error / timeout        -> retry
 *   - HTTP 408, 425, 429             -> retry (429 memakai Retry-After)
 *   - HTTP 5xx                       -> retry
 *   - HTTP 4xx lainnya               -> TIDAK di-retry (permanen, mis. 401/404)
 */

import { HttpError } from './errors.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Jeda yang MENAHAN event loop tetap hidup.
 *
 * Timer-nya sengaja tidak di-unref: jeda ini dipakai di antara percobaan ulang,
 * dan proses tidak boleh keluar di tengah backoff sementara sebuah request
 * masih menunggu giliran dicoba lagi.
 *
 * @param {number} ms
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Menentukan apakah sebuah status HTTP layak dicoba ulang.
 * @param {number} status
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Membaca header Retry-After (detik ATAU HTTP-date) menjadi milliseconds.
 * @param {Headers} headers
 * @returns {number | undefined}
 */
export function parseRetryAfter(headers) {
  const raw = headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Discord juga mengirim header khusus ini, resolusinya lebih halus.
  const discordReset = headers.get('x-ratelimit-reset-after');
  if (discordReset) {
    const seconds = Number(discordReset);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return undefined;
}

/**
 * Backoff eksponensial dengan jitter penuh, dibatasi maksimum.
 * @param {number} attempt percobaan ke-berapa (mulai 0)
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {() => number} [rng] bisa di-inject saat testing
 */
export function backoffDelay(attempt, baseMs = 1000, maxMs = 30_000, rng = Math.random) {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  // Full jitter: antara 50% dan 100% dari nilai eksponensial.
  return Math.round(exponential * (0.5 + rng() * 0.5));
}

/**
 * `fetch` dengan timeout keras. Selalu melempar HttpError (bukan TypeError
 * mentah) supaya pemanggil punya bentuk error yang konsisten.
 *
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = 15_000, headers, ...rest } = init;
  try {
    return await fetch(url, {
      ...rest,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    const name = error?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new HttpError(`Request timeout setelah ${timeoutMs}ms: ${url}`, {
        retryable: true,
      });
    }
    throw new HttpError(`Network error: ${error?.message ?? String(error)}`, {
      retryable: true,
    });
  }
}

/**
 * Menjalankan `task` dengan retry + exponential backoff.
 * `task` boleh melempar HttpError; hanya error dengan `retryable === true`
 * yang diulang. `retryAfterMs` (dari HTTP 429) selalu dihormati.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} task
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   onRetry?: (info: { attempt: number, delayMs: number, error: Error }) => void,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   rng?: () => number,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(task, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    onRetry,
    sleepFn = sleep,
    rng = Math.random,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof HttpError ? error.retryable : false;
      if (!retryable || attempt === retries) break;

      const delayMs = error.retryAfterMs ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, rng);
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

/**
 * GET JSON dengan timeout + retry. Melempar HttpError bila status non-2xx
 * atau body bukan JSON yang valid.
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, retries?: number, onRetry?: Function }} [options]
 * @returns {Promise<any>}
 */
export async function getJson(url, options = {}) {
  const { headers, timeoutMs, retries = 3, onRetry } = options;

  return withRetry(
    async () => {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { accept: 'application/json, text/plain, */*', ...headers },
        timeoutMs,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} dari ${new URL(url).host}`, {
          status: response.status,
          retryable: isRetryableStatus(response.status),
          retryAfterMs: parseRetryAfter(response.headers),
          body: text.slice(0, 300),
        });
      }

      try {
        return JSON.parse(text);
      } catch {
        // Ini yang terjadi kalau TikTok membalas halaman WAF/HTML alih-alih JSON.
        throw new HttpError('Response bukan JSON yang valid', {
          status: response.status,
          retryable: false,
          body: text.slice(0, 300),
        });
      }
    },
    { retries, onRetry },
  );
}

/**
 * GET body sebagai teks mentah (dipakai untuk membaca HTML profil).
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, retries?: number, onRetry?: Function }} [options]
 * @returns {Promise<string>}
 */
export async function getText(url, options = {}) {
  const { headers, timeoutMs, retries = 2, onRetry } = options;

  return withRetry(
    async () => {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
        timeoutMs,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} dari ${new URL(url).host}`, {
          status: response.status,
          retryable: isRetryableStatus(response.status),
          retryAfterMs: parseRetryAfter(response.headers),
          body: text.slice(0, 300),
        });
      }
      return text;
    },
    { retries, onRetry },
  );
}
