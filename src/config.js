/**
 * Pemuatan dan validasi konfigurasi.
 *
 * Prinsip: aplikasi GAGAL SAAT START dengan pesan yang jelas kalau konfigurasi
 * wajib tidak ada — bukan crash misterius di tengah jalan beberapa menit kemudian.
 *
 * Tidak ada dependency: `process.loadEnvFile()` adalah API bawaan Node (>= 20.12
 * / 21.7), jadi `dotenv` tidak diperlukan.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigError } from './utils/errors.js';
import { normalizeUsername } from './utils/format.js';

/** Interval polling paling cepat yang diizinkan, agar tetap sopan ke TikTok. */
export const MIN_CHECK_INTERVAL = 15_000;

const CONTENT_PROVIDERS = new Set(['web', 'official', 'mock', 'disabled']);

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Memuat file .env ke `process.env` bila ada.
 * Variabel yang sudah ada di environment (mis. dari PM2 atau Docker) menang.
 *
 * @param {string} [envPath]
 * @returns {boolean} true kalau ada file yang dimuat
 */
export function loadEnvFile(envPath = resolve(process.cwd(), '.env')) {
  if (!existsSync(envPath)) return false;
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch (error) {
    throw new ConfigError(`Gagal membaca file .env di ${envPath}: ${error?.message}`);
  }
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @param {string[]} errors
 */
function readInteger(env, key, fallback, bounds, errors) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(`${key} harus berupa bilangan bulat, dapat "${raw}".`);
    return fallback;
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    errors.push(`${key} minimal ${bounds.min}, dapat ${value}.`);
    return fallback;
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    errors.push(`${key} maksimal ${bounds.max}, dapat ${value}.`);
    return fallback;
  }
  return value;
}

/**
 * Memvalidasi bentuk URL webhook Discord tanpa menghubungi jaringan.
 *
 * @param {string|undefined} raw
 * @param {string} key
 * @param {string[]} errors
 * @returns {string|null}
 */
function readWebhookUrl(raw, key, errors) {
  const value = raw?.trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${key} bukan URL yang valid.`);
    return null;
  }

  if (url.protocol !== 'https:') {
    errors.push(`${key} harus memakai https.`);
    return null;
  }
  if (!/^(canary\.|ptb\.)?discord(app)?\.com$/i.test(url.hostname)) {
    errors.push(`${key} harus mengarah ke domain discord.com, dapat "${url.hostname}".`);
    return null;
  }
  if (!/^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    errors.push(
      `${key} formatnya salah. Harus seperti https://discord.com/api/webhooks/<id>/<token>.`,
    );
    return null;
  }

  // Query string dibuang: `?wait=true` ditambahkan sendiri oleh discord service.
  return `${url.origin}${url.pathname}`;
}

/**
 * Membangun objek konfigurasi dari environment.
 * Mengumpulkan SEMUA masalah lalu melaporkannya sekaligus, supaya pengguna
 * tidak harus memperbaiki satu per satu lewat restart berulang.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<ReturnType<typeof buildConfig>>}
 */
export function buildConfig(env = process.env) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const username = normalizeUsername(env.TIKTOK_USERNAME);
  if (!username) {
    errors.push('TIKTOK_USERNAME wajib diisi (username TikTok tanpa tanda @).');
  } else if (!/^[\w.]{1,24}$/.test(username)) {
    errors.push(
      `TIKTOK_USERNAME "${username}" tidak valid. Username TikTok hanya berisi huruf, angka, titik, dan underscore.`,
    );
  }

  const liveWebhookUrl = readWebhookUrl(
    env.DISCORD_LIVE_WEBHOOK_URL,
    'DISCORD_LIVE_WEBHOOK_URL',
    errors,
  );
  const contentWebhookUrl = readWebhookUrl(
    env.DISCORD_CONTENT_WEBHOOK_URL,
    'DISCORD_CONTENT_WEBHOOK_URL',
    errors,
  );

  if (!liveWebhookUrl && !contentWebhookUrl) {
    errors.push(
      'Minimal salah satu dari DISCORD_LIVE_WEBHOOK_URL atau DISCORD_CONTENT_WEBHOOK_URL harus diisi.',
    );
  }
  if (!liveWebhookUrl) {
    warnings.push(
      'DISCORD_LIVE_WEBHOOK_URL belum diisi — monitoring LIVE dinonaktifkan.',
    );
  }
  if (!contentWebhookUrl) {
    warnings.push(
      'DISCORD_CONTENT_WEBHOOK_URL belum diisi — monitoring konten dinonaktifkan.',
    );
  }

  const checkInterval = readInteger(
    env,
    'CHECK_INTERVAL',
    60_000,
    { min: MIN_CHECK_INTERVAL, max: 86_400_000 },
    errors,
  );
  const liveUpdateInterval = readInteger(
    env,
    'LIVE_UPDATE_INTERVAL',
    300_000,
    { min: 0, max: 86_400_000 },
    errors,
  );
  const maxContentPerCycle = readInteger(env, 'MAX_CONTENT_PER_CYCLE', 3, { min: 1, max: 20 }, errors);
  const requestTimeout = readInteger(env, 'REQUEST_TIMEOUT', 15_000, { min: 1000, max: 120_000 }, errors);
  const maxRetries = readInteger(env, 'MAX_RETRIES', 3, { min: 0, max: 10 }, errors);

  if (liveUpdateInterval > 0 && liveUpdateInterval < checkInterval) {
    warnings.push(
      `LIVE_UPDATE_INTERVAL (${liveUpdateInterval}ms) lebih kecil dari CHECK_INTERVAL (${checkInterval}ms); ` +
        'update penonton tetap dibatasi oleh CHECK_INTERVAL.',
    );
  }

  const contentProvider = (env.TIKTOK_CONTENT_PROVIDER ?? 'web').trim().toLowerCase();
  if (!CONTENT_PROVIDERS.has(contentProvider)) {
    errors.push(
      `TIKTOK_CONTENT_PROVIDER harus salah satu dari: ${[...CONTENT_PROVIDERS].join(', ')}. Dapat "${contentProvider}".`,
    );
  }

  const official = {
    clientKey: env.TIKTOK_CLIENT_KEY?.trim() || null,
    clientSecret: env.TIKTOK_CLIENT_SECRET?.trim() || null,
    refreshToken: env.TIKTOK_REFRESH_TOKEN?.trim() || null,
  };
  if (contentProvider === 'official') {
    const missing = Object.entries(official)
      .filter(([, v]) => !v)
      .map(([k]) => `TIKTOK_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
    if (missing.length > 0) {
      errors.push(
        `TIKTOK_CONTENT_PROVIDER=official membutuhkan: ${missing.join(', ')}.`,
      );
    }
  }

  const mockFile = env.TIKTOK_MOCK_FILE?.trim() || './data/mock-content.json';
  if (contentProvider === 'mock' && !existsSync(resolve(mockFile))) {
    errors.push(`TIKTOK_MOCK_FILE tidak ditemukan: ${resolve(mockFile)}`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    errors.push(`LOG_LEVEL harus salah satu dari: ${[...LOG_LEVELS].join(', ')}. Dapat "${logLevel}".`);
  }

  const stateFile = resolve(env.STATE_FILE?.trim() || './data/state.json');

  if (errors.length > 0) {
    throw new ConfigError(
      `Konfigurasi tidak valid:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
        'Periksa file .env kamu. Contoh lengkapnya ada di .env.example.',
    );
  }

  return Object.freeze({
    username,
    profileUrl: `https://www.tiktok.com/@${username}`,
    liveUrl: `https://www.tiktok.com/@${username}/live`,

    discord: Object.freeze({
      liveWebhookUrl,
      contentWebhookUrl,
    }),

    checkInterval,
    liveUpdateInterval,
    maxContentPerCycle,
    requestTimeout,
    maxRetries,

    contentProvider,
    official: Object.freeze(official),
    mockFile: resolve(mockFile),

    logLevel,
    stateFile,

    liveEnabled: Boolean(liveWebhookUrl),
    contentEnabled: Boolean(contentWebhookUrl) && contentProvider !== 'disabled',

    warnings: Object.freeze(warnings),
  });
}
