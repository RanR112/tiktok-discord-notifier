/**
 * Monitor konten/video baru.
 *
 * Dua masalah yang harus dicegah:
 *
 * 1. Banjir saat pertama kali jalan / state hilang.
 *    Siklus pertama (`contentBootstrapped === false`) HANYA merekam id video
 *    yang sudah ada tanpa mengirim notifikasi apa pun. Tanpa ini, instalasi
 *    baru akan mengirim seluruh video lama ke channel.
 *
 * 2. Notifikasi ganda untuk video yang sama.
 *    Setiap id yang pernah dilihat disimpan di `knownContentIds` (ring buffer
 *    100 id terakhir) di file state, jadi tetap bertahan setelah restart.
 *    Memakai daftar id, bukan hanya `lastContentId`, karena urutan feed TikTok
 *    bisa berubah (video yang di-pin naik ke atas) — kalau hanya mengandalkan
 *    satu id terakhir, video lama bisa terdeteksi sebagai "baru".
 */

import { ProviderUnavailableError } from '../utils/errors.js';
import { rememberContentIds } from '../utils/state.js';

/**
 * Keputusan murni: item mana yang perlu dinotifikasi.
 *
 * @param {import('../types.js').ContentItem[]} items terbaru lebih dulu
 * @param {import('../types.js').AppState} state
 * @param {{ maxPerCycle?: number }} [options]
 * @returns {{
 *   toNotify: import('../types.js').ContentItem[],
 *   allIds: string[],
 *   skipped: number,
 *   bootstrap: boolean,
 * }}
 */
export function selectNewContent(items, state, options = {}) {
  const { maxPerCycle = 3 } = options;
  const allIds = items.map((item) => item.id);

  if (!state.contentBootstrapped) {
    return { toNotify: [], allIds, skipped: 0, bootstrap: true };
  }

  const known = new Set(state.knownContentIds);
  const fresh = items.filter((item) => !known.has(item.id));

  // `fresh` tersusun terbaru-dulu. Ambil yang paling baru sebanyak batas,
  // lalu balik urutannya supaya notifikasi terkirim secara kronologis.
  const selected = fresh.slice(0, maxPerCycle).reverse();

  return {
    toNotify: selected,
    allIds,
    skipped: Math.max(0, fresh.length - selected.length),
    bootstrap: false,
  };
}

export class ContentMonitor {
  /**
   * @param {{
   *   tiktok: import('../services/tiktok.js').TikTokService,
   *   discord: import('../services/discord.js').DiscordService,
   *   store: import('../utils/state.js').StateStore,
   *   config: any,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ tiktok, discord, store, config, logger }) {
    this.tiktok = tiktok;
    this.discord = discord;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.consecutiveFailures = 0;
  }

  get name() {
    return 'content';
  }

  /**
   * Satu siklus pengecekan konten.
   * Selalu resolve — error dilaporkan lewat nilai balik, bukan dilempar.
   *
   * @returns {Promise<{ ok: boolean, notified?: number, error?: Error }>}
   */
  async check() {
    this.logger.info(
      `Mengecek konten baru @${this.config.username} (provider: ${this.tiktok.contentProviderName})...`,
    );

    /** @type {import('../types.js').ContentItem[]} */
    let items;
    try {
      items = await this.tiktok.getLatestContent();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (error instanceof ProviderUnavailableError) {
        const hint =
          error.reason === 'challenge'
            ? ' TikTok memblokir request dengan halaman verifikasi anti-bot. ' +
              'Ini keterbatasan yang diketahui dari provider "web" — lihat README bagian Keterbatasan.'
            : '';
        this.logger.warn(`Konten tidak bisa dibaca: ${error.message}${hint}`, {
          reason: error.reason,
          consecutiveFailures: this.consecutiveFailures,
        });
      } else {
        this.logger.error(`Error tak terduga saat mengecek konten: ${error?.message}`, {
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return { ok: false, error };
    }

    if (items.length === 0) {
      this.logger.warn('Provider tidak mengembalikan satu pun video. Dilewati.');
      return { ok: true, notified: 0 };
    }

    const state = this.store.get();
    const { toNotify, allIds, skipped, bootstrap } = selectNewContent(items, state, {
      maxPerCycle: this.config.maxContentPerCycle,
    });

    if (bootstrap) {
      await this.store.update({
        knownContentIds: rememberContentIds(state.knownContentIds, allIds),
        lastContentId: allIds[0] ?? null,
        contentBootstrapped: true,
      });
      this.logger.info(
        `Sinkronisasi awal selesai: ${allIds.length} video lama direkam sebagai "sudah dilihat". ` +
          'Tidak ada notifikasi dikirim. Video berikutnya akan dinotifikasi.',
      );
      return { ok: true, notified: 0 };
    }

    if (toNotify.length === 0) {
      this.logger.info('Tidak ada video baru.');
      await this.store.update({ knownContentIds: rememberContentIds(state.knownContentIds, allIds) });
      return { ok: true, notified: 0 };
    }

    if (skipped > 0) {
      this.logger.warn(
        `${skipped} video baru lainnya dilewati pada siklus ini (batas MAX_CONTENT_PER_CYCLE=${this.config.maxContentPerCycle}) ` +
          'agar tidak membanjiri channel. Video tersebut ditandai sudah dilihat.',
      );
    }

    let notified = 0;
    /** @type {Error|null} */
    let sendError = null;
    for (const item of toNotify) {
      try {
        const enriched = await this.tiktok.enrichContent(item);
        await this.discord.sendContentNotification(enriched);
        notified += 1;

        // Ditandai satu per satu: kalau pengiriman ke-2 gagal, yang ke-1 tetap
        // tercatat dan tidak akan dikirim ulang setelah restart.
        await this.store.update({
          knownContentIds: rememberContentIds(this.store.get().knownContentIds, [item.id]),
          lastContentId: item.id,
        });
      } catch (error) {
        sendError = error;
        this.logger.error(
          `Gagal mengirim notifikasi untuk video ${item.id}: ${error?.message}. ` +
            'Akan dicoba lagi pada siklus berikutnya.',
        );
        // Sengaja berhenti: kalau Discord sedang bermasalah, item berikutnya
        // kemungkinan besar juga gagal. Urutan kronologis tetap terjaga.
        break;
      }
    }

    // Item yang dilewati karena batas per siklus ditandai sudah dilihat di sini,
    // supaya tidak menumpuk dan membanjiri channel di siklus-siklus berikutnya.
    if (skipped > 0) {
      await this.store.update({
        knownContentIds: rememberContentIds(this.store.get().knownContentIds, allIds),
      });
    }

    if (sendError) {
      this.logger.warn(
        `${notified}/${toNotify.length} notifikasi video terkirim; sisanya tertunda ke siklus berikutnya.`,
      );
      return { ok: false, notified, error: sendError };
    }

    this.logger.info(`${notified} notifikasi video terkirim.`);
    return { ok: true, notified };
  }
}
