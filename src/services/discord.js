/**
 * Discord webhook service.
 *
 * Dua fungsi terpisah dengan tujuan yang tidak ambigu:
 *   sendLiveNotification(data)    -> HANYA ke DISCORD_LIVE_WEBHOOK_URL
 *   sendContentNotification(data) -> HANYA ke DISCORD_CONTENT_WEBHOOK_URL
 *
 * URL diikat ke instance saat konstruksi dan tidak pernah dilewatkan sebagai
 * argumen, sehingga secara struktural mustahil mengirim notifikasi konten ke
 * webhook LIVE atau sebaliknya.
 */

import { HttpError } from '../utils/errors.js';
import { fetchWithTimeout, isRetryableStatus, parseRetryAfter, withRetry } from '../utils/http.js';
import { formatNumber, safeUrl, toIsoTimestamp, truncate } from '../utils/format.js';

/** Merah khas TikTok — dipakai untuk LIVE. */
export const COLOR_LIVE = 0xfe2c55;
/** Cyan khas TikTok — dipakai untuk konten baru. */
export const COLOR_CONTENT = 0x25f4ee;
/** Abu-abu — dipakai saat sesi LIVE sudah berakhir. */
export const COLOR_LIVE_ENDED = 0x4f545c;

/** Batas panjang dari dokumentasi Discord. */
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
};

/**
 * Membuang field yang bernilai null/undefined secara rekursif.
 * Discord menolak payload yang memuat `"url": null`.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function compact(value) {
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map(compact).filter((v) => v !== undefined));
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const cleaned = compact(v);
      if (cleaned === undefined) continue;
      if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
        continue;
      }
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      out[k] = cleaned;
    }
    return /** @type {any} */ (out);
  }
  return value;
}

/**
 * Membuat satu field embed inline, atau null kalau nilainya tidak tersedia.
 * Dipakai supaya statistik yang tidak diketahui DIHILANGKAN, bukan ditulis "0".
 *
 * @param {string} name
 * @param {string|null} value
 */
function statField(name, value) {
  if (!value) return null;
  return { name: truncate(name, LIMITS.fieldName), value: truncate(value, LIMITS.fieldValue), inline: true };
}

/**
 * Menyusun embed untuk notifikasi LIVE.
 *
 * @param {import('../types.js').LiveStatus} data
 * @param {{ ended?: boolean }} [options]
 */
export function buildLiveEmbed(data, options = {}) {
  const { ended = false } = options;
  const displayName = data.displayName || data.username;
  const url = safeUrl(data.url);
  const viewers = formatNumber(data.viewers);

  const descriptionLines = [
    ended
      ? `**@${data.username}** sudah selesai LIVE.`
      : `**@${data.username}** sedang LIVE sekarang!`,
  ];
  if (data.title) {
    descriptionLines.push('', `> ${truncate(data.title, 500)}`);
  }

  return compact({
    title: ended ? '⚫ LIVE Berakhir' : '🔴 TikTok LIVE',
    url,
    color: ended ? COLOR_LIVE_ENDED : COLOR_LIVE,
    description: truncate(descriptionLines.join('\n'), LIMITS.description),
    author: {
      name: truncate(`${displayName} (@${data.username})`, LIMITS.author),
      url: `https://www.tiktok.com/@${data.username}`,
      icon_url: safeUrl(data.avatar),
    },
    fields: [
      data.title ? { name: 'Title', value: truncate(data.title, LIMITS.fieldValue), inline: false } : null,
      statField('👁️ Viewers', viewers),
      data.startedAt
        ? {
            name: '⏱️ Mulai',
            value: `<t:${Math.floor(new Date(data.startedAt).getTime() / 1000)}:R>`,
            inline: true,
          }
        : null,
      url ? { name: '🔗 Link', value: `[Watch LIVE](${url})`, inline: false } : null,
    ].filter(Boolean),
    image: safeUrl(data.thumbnail) ? { url: safeUrl(data.thumbnail) } : null,
    footer: { text: truncate('TikTok LIVE Notifier', LIMITS.footer) },
    timestamp: toIsoTimestamp(data.startedAt) ?? new Date().toISOString(),
  });
}

/**
 * Menyusun embed untuk notifikasi konten baru.
 *
 * @param {import('../types.js').ContentItem} data
 */
export function buildContentEmbed(data) {
  const displayName = data.displayName || data.username;
  const url = safeUrl(data.url);

  const stats = [
    statField('👁️ Views', formatNumber(data.views)),
    statField('❤️ Likes', formatNumber(data.likes)),
    statField('💬 Comments', formatNumber(data.comments)),
    statField('🔄 Shares', formatNumber(data.shares)),
  ].filter(Boolean);

  const descriptionLines = [`**@${data.username}**`];
  if (data.caption) {
    descriptionLines.push('', `> ${truncate(data.caption, 600).replace(/\n/g, '\n> ')}`);
  }

  return compact({
    title: '🎬 New TikTok Video',
    url,
    color: COLOR_CONTENT,
    description: truncate(descriptionLines.join('\n'), LIMITS.description),
    author: {
      name: truncate(`${displayName} (@${data.username})`, LIMITS.author),
      url: `https://www.tiktok.com/@${data.username}`,
    },
    fields: [
      ...stats,
      url ? { name: '🔗 Link', value: `[Watch on TikTok](${url})`, inline: false } : null,
    ].filter(Boolean),
    image: safeUrl(data.thumbnail) ? { url: safeUrl(data.thumbnail) } : null,
    footer: {
      text: truncate(
        stats.length > 0 ? 'TikTok Content Notifier' : 'TikTok Content Notifier • statistik tidak tersedia',
        LIMITS.footer,
      ),
    },
    timestamp: toIsoTimestamp(data.publishedAt) ?? new Date().toISOString(),
  });
}

export class DiscordService {
  /**
   * @param {{
   *   liveWebhookUrl: string|null,
   *   contentWebhookUrl: string|null,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ liveWebhookUrl, contentWebhookUrl, timeoutMs = 15_000, retries = 3, logger }) {
    this.liveWebhookUrl = liveWebhookUrl;
    this.contentWebhookUrl = contentWebhookUrl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  /**
   * Mengirim satu request ke Discord dengan retry + penghormatan rate limit.
   *
   * @param {string} url
   * @param {object} payload
   * @param {{ method?: string, label: string }} options
   * @returns {Promise<{ id: string|null }>}
   * @private
   */
  async #request(url, payload, { method = 'POST', label }) {
    // `?wait=true` membuat Discord membalas objek pesan, sehingga id-nya bisa
    // disimpan dan pesan LIVE yang sama bisa di-EDIT saat penonton berubah.
    const target = method === 'POST' ? `${url}?wait=true` : url;

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(target, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          timeoutMs: this.timeoutMs,
        });

        const text = await response.text();

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers) ?? 5000;
          this.logger.warn(
            `Discord rate limit (429) saat ${label}. Menunggu ${retryAfterMs}ms sebelum mencoba lagi.`,
          );
          throw new HttpError('Discord rate limit', {
            status: 429,
            retryable: true,
            retryAfterMs,
          });
        }

        if (!response.ok) {
          throw new HttpError(`Discord membalas HTTP ${response.status} saat ${label}`, {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            body: text.slice(0, 300),
          });
        }

        try {
          const body = text ? JSON.parse(text) : null;
          return { id: body?.id ?? null };
        } catch {
          return { id: null };
        }
      },
      {
        retries: this.retries,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `Percobaan ulang ${attempt}/${this.retries} untuk ${label} dalam ${delayMs}ms: ${error.message}`,
          );
        },
      },
    );
  }

  /**
   * Notifikasi LIVE. HANYA memakai DISCORD_LIVE_WEBHOOK_URL.
   *
   * @param {import('../types.js').LiveStatus} data
   * @returns {Promise<{ id: string|null }|null>} null kalau webhook tidak dikonfigurasi
   */
  async sendLiveNotification(data) {
    if (!this.liveWebhookUrl) {
      this.logger.debug('Notifikasi LIVE dilewati: DISCORD_LIVE_WEBHOOK_URL tidak dikonfigurasi.');
      return null;
    }

    const payload = {
      username: 'TikTok LIVE',
      content: `🔴 **@${data.username}** sedang LIVE!`,
      embeds: [buildLiveEmbed(data)],
      allowed_mentions: { parse: [] },
    };

    const result = await this.#request(this.liveWebhookUrl, payload, {
      label: 'kirim notifikasi LIVE',
    });
    this.logger.info(`Notifikasi LIVE terkirim untuk @${data.username}`, {
      liveId: data.liveId,
      messageId: result.id,
    });
    return result;
  }

  /**
   * Meng-EDIT pesan LIVE yang sudah ada (mis. saat jumlah penonton berubah).
   * Meng-edit jauh lebih hemat rate limit daripada mengirim pesan baru.
   *
   * @param {string} messageId
   * @param {import('../types.js').LiveStatus} data
   * @param {{ ended?: boolean }} [options]
   * @returns {Promise<boolean>} true kalau berhasil
   */
  async updateLiveNotification(messageId, data, options = {}) {
    if (!this.liveWebhookUrl || !messageId) return false;

    const payload = {
      content: options.ended
        ? `⚫ **@${data.username}** sudah selesai LIVE.`
        : `🔴 **@${data.username}** sedang LIVE!`,
      embeds: [buildLiveEmbed(data, options)],
      allowed_mentions: { parse: [] },
    };

    try {
      await this.#request(`${this.liveWebhookUrl}/messages/${messageId}`, payload, {
        method: 'PATCH',
        label: 'update pesan LIVE',
      });
      this.logger.info(`Pesan LIVE diperbarui untuk @${data.username}`, {
        messageId,
        viewers: data.viewers,
        ended: Boolean(options.ended),
      });
      return true;
    } catch (error) {
      // Pesan bisa saja sudah dihapus manual (404). Itu bukan kondisi fatal.
      const level = error?.status === 404 ? 'warn' : 'error';
      this.logger[level](`Gagal memperbarui pesan LIVE: ${error?.message}`, { messageId });
      return false;
    }
  }

  /**
   * Notifikasi konten baru. HANYA memakai DISCORD_CONTENT_WEBHOOK_URL.
   *
   * @param {import('../types.js').ContentItem} data
   * @returns {Promise<{ id: string|null }|null>} null kalau webhook tidak dikonfigurasi
   */
  async sendContentNotification(data) {
    if (!this.contentWebhookUrl) {
      this.logger.debug(
        'Notifikasi konten dilewati: DISCORD_CONTENT_WEBHOOK_URL tidak dikonfigurasi.',
      );
      return null;
    }

    const payload = {
      username: 'TikTok Uploads',
      content: `🎬 Video baru dari **@${data.username}**`,
      embeds: [buildContentEmbed(data)],
      allowed_mentions: { parse: [] },
    };

    const result = await this.#request(this.contentWebhookUrl, payload, {
      label: 'kirim notifikasi konten',
    });
    this.logger.info(`Notifikasi konten terkirim untuk video ${data.id}`, {
      messageId: result.id,
    });
    return result;
  }
}
