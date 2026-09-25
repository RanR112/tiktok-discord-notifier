/**
 * Facade TikTok service.
 *
 * Monitor hanya pernah bicara dengan dua method di sini:
 *   getLiveStatus()     -> LiveStatus
 *   getLatestContent()  -> ContentItem[]  (terbaru lebih dulu)
 *
 * Pemilihan sumber data (web / official / mock / disabled) disembunyikan di
 * balik facade ini, sehingga mengganti strategi pengambilan data tidak
 * menyentuh kode monitor sama sekali.
 */

import { LiveProvider } from './tiktok/liveProvider.js';
import { WebContentProvider } from './tiktok/content/webProvider.js';
import { OfficialContentProvider } from './tiktok/content/officialProvider.js';
import { MockContentProvider } from './tiktok/content/mockProvider.js';
import { fetchOembed } from './tiktok/oembed.js';

/**
 * @param {import('../config.js').buildConfig extends (...a: any) => infer R ? R : never} config
 * @param {ReturnType<typeof import('../utils/logger.js').createLogger>} logger
 */
function createContentProvider(config, logger) {
  const base = {
    username: config.username,
    timeoutMs: config.requestTimeout,
    retries: config.maxRetries,
    logger,
  };

  switch (config.contentProvider) {
    case 'official':
      return new OfficialContentProvider({
        ...base,
        clientKey: config.official.clientKey,
        clientSecret: config.official.clientSecret,
        refreshToken: config.official.refreshToken,
      });
    case 'mock':
      return new MockContentProvider({ ...base, filePath: config.mockFile });
    case 'disabled':
      return null;
    case 'web':
    default:
      return new WebContentProvider(base);
  }
}

export class TikTokService {
  /**
   * @param {{
   *   config: any,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;

    this.liveProvider = new LiveProvider({
      username: config.username,
      timeoutMs: config.requestTimeout,
      retries: config.maxRetries,
      logger: logger.child('live'),
    });

    this.contentProvider = createContentProvider(config, logger.child('content'));
  }

  /** Nama provider konten yang aktif, untuk keperluan logging. */
  get contentProviderName() {
    return this.contentProvider?.name ?? 'disabled';
  }

  /** true kalau data konten bersifat best-effort dan bisa saja kosong. */
  get contentIsBestEffort() {
    return this.contentProvider?.bestEffort === true;
  }

  /**
   * @returns {Promise<import('../types.js').LiveStatus>}
   */
  async getLiveStatus() {
    return this.liveProvider.getLiveStatus();
  }

  /**
   * @returns {Promise<import('../types.js').ContentItem[]>} terbaru lebih dulu
   */
  async getLatestContent() {
    if (!this.contentProvider) return [];
    return this.contentProvider.getLatestContent();
  }

  /**
   * Melengkapi item yang caption/thumbnail-nya kosong memakai oEmbed resmi.
   * Bersifat opsional: kegagalan di sini tidak pernah membatalkan notifikasi.
   *
   * @param {import('../types.js').ContentItem} item
   * @returns {Promise<import('../types.js').ContentItem>}
   */
  async enrichContent(item) {
    if (item.caption && item.thumbnail && item.displayName) return item;

    const extra = await fetchOembed(item.url, { timeoutMs: this.config.requestTimeout });
    if (!extra) return item;

    return {
      ...item,
      caption: item.caption ?? extra.caption,
      thumbnail: item.thumbnail ?? extra.thumbnail,
      displayName: item.displayName ?? extra.displayName,
    };
  }
}
