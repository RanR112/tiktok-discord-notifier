/**
 * Content provider "web" — BEST EFFORT. Baca README bagian Keterbatasan.
 *
 * Cara kerja: mengambil halaman profil publik `https://www.tiktok.com/@user`
 * lalu membaca blok JSON yang TikTok sendiri tanamkan di HTML untuk hidrasi
 * front-end (`__UNIVERSAL_DATA_FOR_REHYDRATION__`, atau `SIGI_STATE` pada versi
 * halaman yang lebih lama). Tidak ada login, cookie, signature, maupun
 * penyelesaian CAPTCHA — murni membaca HTML publik yang sama dengan yang
 * diterima browser biasa.
 *
 * KETERBATASAN YANG SUDAH TERVERIFIKASI (2026-09-25):
 * TikTok memasang WAF anti-bot. Request dari IP datacenter/VPS sering dibalas
 * halaman tantangan ("Please wait...", `_wafchallengeid`) alih-alih HTML profil.
 * Kalau itu terjadi, provider ini melempar ProviderUnavailableError dengan
 * reason "challenge" — TIDAK mengarang data, dan TIDAK mencoba menembus WAF.
 * Monitor akan mencatat WARN lalu mencoba lagi di siklus berikutnya.
 */

import { getText } from '../../../utils/http.js';
import { ProviderUnavailableError } from '../../../utils/errors.js';
import { safeUrl, toIsoTimestamp } from '../../../utils/format.js';

const UNIVERSAL_DATA_RE =
  /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;
const SIGI_STATE_RE = /<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/;

/** Penanda halaman tantangan anti-bot TikTok. */
const CHALLENGE_RE = /_wafchallengeid|slardarClient|Please wait\.\.\./i;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Mengubah satu item mentah dari webapp TikTok menjadi ContentItem.
 *
 * @param {any} raw
 * @param {{ username: string, displayName: string|null }} context
 * @returns {import('../../../types.js').ContentItem|null}
 */
export function mapWebItem(raw, context) {
  const id = typeof raw?.id === 'string' ? raw.id : raw?.id != null ? String(raw.id) : null;
  if (!id) return null;

  const author = raw.author ?? {};
  const username =
    (typeof author.uniqueId === 'string' && author.uniqueId) || context.username;
  const stats = raw.stats ?? raw.statsV2 ?? {};
  const video = raw.video ?? {};

  return {
    id,
    username,
    displayName:
      (typeof author.nickname === 'string' && author.nickname) || context.displayName || null,
    caption: typeof raw.desc === 'string' && raw.desc.trim() !== '' ? raw.desc.trim() : null,
    url: `https://www.tiktok.com/@${username}/video/${id}`,
    thumbnail: safeUrl(video.cover ?? video.originCover ?? video.dynamicCover),
    publishedAt: toIsoTimestamp(raw.createTime),
    views: num(stats.playCount),
    likes: num(stats.diggCount),
    comments: num(stats.commentCount),
    shares: num(stats.shareCount),
    source: 'web',
  };
}

/**
 * Mengekstrak daftar item + info user dari HTML profil.
 * Dipisah dari bagian jaringan supaya bisa diuji dengan fixture HTML.
 *
 * @param {string} html
 * @param {string} username
 * @returns {{ items: import('../../../types.js').ContentItem[], displayName: string|null }}
 * @throws {ProviderUnavailableError}
 */
export function parseProfileHtml(html, username) {
  if (CHALLENGE_RE.test(html) && !UNIVERSAL_DATA_RE.test(html)) {
    throw new ProviderUnavailableError(
      'TikTok membalas halaman verifikasi anti-bot, bukan halaman profil.',
      { reason: 'challenge' },
    );
  }

  const universal = html.match(UNIVERSAL_DATA_RE);
  if (universal) {
    let parsed;
    try {
      parsed = JSON.parse(universal[1]);
    } catch (error) {
      throw new ProviderUnavailableError('Blok data profil TikTok bukan JSON yang valid.', {
        cause: error,
        reason: 'shape',
      });
    }

    const scope = parsed?.__DEFAULT_SCOPE__ ?? {};
    const user = scope['webapp.user-detail']?.userInfo?.user ?? {};
    const displayName = typeof user.nickname === 'string' && user.nickname ? user.nickname : null;

    const rawItems =
      scope['webapp.user-post']?.itemList ??
      scope['webapp.user-post']?.itemInfo?.itemList ??
      scope['webapp.item-list']?.itemList ??
      null;

    if (!Array.isArray(rawItems)) {
      // Halaman terbaca, tapi daftar video dirender di sisi klien.
      throw new ProviderUnavailableError(
        'Halaman profil terbaca tetapi daftar video tidak ikut tertanam di HTML.',
        { reason: 'no-item-list' },
      );
    }

    return {
      displayName,
      items: rawItems
        .map((item) => mapWebItem(item, { username, displayName }))
        .filter(Boolean),
    };
  }

  const sigi = html.match(SIGI_STATE_RE);
  if (sigi) {
    let parsed;
    try {
      parsed = JSON.parse(sigi[1]);
    } catch (error) {
      throw new ProviderUnavailableError('Blok SIGI_STATE bukan JSON yang valid.', {
        cause: error,
        reason: 'shape',
      });
    }

    const itemModule = parsed?.ItemModule ?? {};
    const userModule = parsed?.UserModule?.users ?? {};
    const displayName =
      typeof userModule[username]?.nickname === 'string' ? userModule[username].nickname : null;

    return {
      displayName,
      items: Object.values(itemModule)
        .map((item) => mapWebItem(item, { username, displayName }))
        .filter(Boolean),
    };
  }

  throw new ProviderUnavailableError(
    'Struktur halaman profil TikTok tidak dikenali (blok data tidak ditemukan).',
    { reason: 'shape' },
  );
}

export class WebContentProvider {
  /**
   * @param {{
   *   username: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../../../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ username, timeoutMs = 15_000, retries = 2, logger }) {
    this.username = username;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  get name() {
    return 'web';
  }

  get bestEffort() {
    return true;
  }

  /**
   * @returns {Promise<import('../../../types.js').ContentItem[]>} terbaru lebih dulu
   * @throws {ProviderUnavailableError}
   */
  async getLatestContent() {
    const url = `https://www.tiktok.com/@${encodeURIComponent(this.username)}`;

    let html;
    try {
      html = await getText(url, {
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `Percobaan ulang ${attempt} pengecekan konten dalam ${delayMs}ms: ${error.message}`,
          );
        },
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        `Tidak bisa membaca halaman profil TikTok: ${error?.message}`,
        { cause: error, reason: 'network' },
      );
    }

    const { items } = parseProfileHtml(html, this.username);

    // Urutkan terbaru lebih dulu; TikTok biasanya sudah begitu, tapi jangan diandalkan.
    return items.sort((a, b) => {
      const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return bt - at;
    });
  }
}
