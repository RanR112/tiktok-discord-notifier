/**
 * Content provider "mock" — membaca item dari file JSON lokal.
 *
 * Gunanya untuk menguji alur end-to-end (dedup, bentuk embed, pengiriman ke
 * Discord) tanpa menyentuh TikTok sama sekali. File dibaca ulang setiap siklus,
 * jadi kamu bisa menambah satu item ke file lalu melihat notifikasinya muncul.
 *
 * Bentuk file: array ContentItem, atau { "items": [...] }.
 */

import { readFile } from 'node:fs/promises';

import { ProviderUnavailableError } from '../../../utils/errors.js';
import { safeUrl, toIsoTimestamp } from '../../../utils/format.js';

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class MockContentProvider {
  /**
   * @param {{
   *   username: string,
   *   filePath: string,
   *   logger: ReturnType<typeof import('../../../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ username, filePath, logger }) {
    this.username = username;
    this.filePath = filePath;
    this.logger = logger;
  }

  get name() {
    return 'mock';
  }

  get bestEffort() {
    return false;
  }

  /**
   * @returns {Promise<import('../../../types.js').ContentItem[]>}
   */
  async getLatestContent() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      throw new ProviderUnavailableError(
        `Tidak bisa membaca file mock (${this.filePath}): ${error?.message}`,
        { cause: error, reason: 'io' },
      );
    }

    const rawItems = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(rawItems)) {
      throw new ProviderUnavailableError(
        'File mock harus berupa array, atau objek dengan properti "items".',
        { reason: 'shape' },
      );
    }

    return rawItems
      .map((raw) => {
        const id = raw?.id != null ? String(raw.id) : null;
        if (!id) return null;
        const username = raw.username || this.username;
        return {
          id,
          username,
          displayName: raw.displayName ?? null,
          caption: raw.caption ?? null,
          url: safeUrl(raw.url) ?? `https://www.tiktok.com/@${username}/video/${id}`,
          thumbnail: safeUrl(raw.thumbnail),
          publishedAt: toIsoTimestamp(raw.publishedAt) ?? new Date().toISOString(),
          views: num(raw.views),
          likes: num(raw.likes),
          comments: num(raw.comments),
          shares: num(raw.shares),
          source: 'mock',
        };
      })
      .filter(Boolean);
  }
}
