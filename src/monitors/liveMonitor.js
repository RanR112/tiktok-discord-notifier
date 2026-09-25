/**
 * Monitor LIVE.
 *
 * Aturan anti-duplikat: satu sesi LIVE = satu notifikasi awal. Sesi dibedakan
 * dengan `roomId` dari TikTok yang disimpan sebagai `state.currentLiveId`.
 *
 *   10:00  LIVE mulai (room A)  -> currentLiveId null   != A  -> KIRIM
 *   10:01  masih LIVE (room A)  -> currentLiveId A      == A  -> diam
 *   10:02  masih LIVE (room A)  -> currentLiveId A      == A  -> diam (opsional: edit penonton)
 *   11:00  LIVE berakhir        -> currentLiveId direset ke null
 *   12:30  LIVE lagi  (room B)  -> currentLiveId null   != B  -> KIRIM
 *
 * Update jumlah penonton dilakukan dengan MENG-EDIT pesan Discord yang sama,
 * bukan mengirim pesan baru, dan dibatasi oleh LIVE_UPDATE_INTERVAL. Jadi
 * berapa pun lamanya siaran, channel hanya menerima satu pesan per sesi.
 */

import { ProviderUnavailableError } from '../utils/errors.js';

/**
 * Menentukan identitas sesi LIVE. TikTok hampir selalu memberi `roomId`;
 * kalau tidak, waktu mulai dipakai sebagai cadangan agar sesi tetap bisa
 * dibedakan.
 *
 * @param {import('../types.js').LiveStatus} status
 * @returns {string|null}
 */
export function resolveLiveId(status) {
  if (!status?.isLive) return null;
  if (status.liveId) return status.liveId;
  if (status.startedAt) return `start:${status.startedAt}`;
  return 'unknown-session';
}

/**
 * Keputusan murni berdasarkan state + status terbaru. Tidak menyentuh jaringan
 * maupun disk, sehingga mudah diuji.
 *
 * @param {import('../types.js').AppState} state
 * @param {import('../types.js').LiveStatus} status
 * @param {{ now?: number, liveUpdateInterval?: number }} [options]
 * @returns {{ action: 'none'|'notify'|'update'|'end', liveId: string|null, reason: string }}
 */
export function decideLiveAction(state, status, options = {}) {
  const { now = Date.now(), liveUpdateInterval = 0 } = options;
  const liveId = resolveLiveId(status);

  if (!status.isLive) {
    if (state.lastLiveStatus || state.currentLiveId) {
      return { action: 'end', liveId: null, reason: 'sesi LIVE berakhir' };
    }
    return { action: 'none', liveId: null, reason: 'tidak LIVE' };
  }

  if (state.currentLiveId !== liveId) {
    return { action: 'notify', liveId, reason: 'sesi LIVE baru terdeteksi' };
  }

  if (liveUpdateInterval <= 0) {
    return { action: 'none', liveId, reason: 'sesi sama, update penonton dinonaktifkan' };
  }
  if (!state.liveMessageId) {
    return { action: 'none', liveId, reason: 'sesi sama, tidak ada pesan untuk di-edit' };
  }

  const lastUpdate = state.lastLiveUpdateAt ? Date.parse(state.lastLiveUpdateAt) : 0;
  if (Number.isFinite(lastUpdate) && now - lastUpdate < liveUpdateInterval) {
    return { action: 'none', liveId, reason: 'sesi sama, belum waktunya update' };
  }
  if (status.viewers === null || status.viewers === state.lastViewerCount) {
    return { action: 'none', liveId, reason: 'sesi sama, jumlah penonton tidak berubah' };
  }

  return { action: 'update', liveId, reason: 'jumlah penonton berubah' };
}

export class LiveMonitor {
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
  }

  get name() {
    return 'live';
  }

  /**
   * Satu siklus pengecekan LIVE.
   * Selalu resolve — error dilaporkan lewat nilai balik, bukan dilempar,
   * supaya kegagalan di sini tidak pernah menghentikan content monitor.
   *
   * @returns {Promise<{ ok: boolean, action?: string, error?: Error }>}
   */
  async check() {
    this.logger.info(`Mengecek status LIVE @${this.config.username}...`);

    /** @type {import('../types.js').LiveStatus} */
    let status;
    try {
      status = await this.tiktok.getLiveStatus();
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        this.logger.warn(`Status LIVE tidak bisa dibaca: ${error.message}`, {
          reason: error.reason,
        });
      } else {
        this.logger.error(`Error tak terduga saat mengecek LIVE: ${error?.message}`);
      }
      return { ok: false, error };
    }

    const decision = decideLiveAction(this.store.get(), status, {
      liveUpdateInterval: this.config.liveUpdateInterval,
    });

    this.logger.debug(`Keputusan LIVE: ${decision.action} (${decision.reason})`, {
      liveId: decision.liveId,
      viewers: status.viewers,
    });

    try {
      switch (decision.action) {
        case 'notify':
          await this.#handleNewSession(status, decision.liveId);
          break;
        case 'update':
          await this.#handleViewerUpdate(status);
          break;
        case 'end':
          await this.#handleSessionEnd(status);
          break;
        default:
          this.logger.info(
            status.isLive
              ? `@${this.config.username} masih LIVE (tidak ada notifikasi baru).`
              : `@${this.config.username} sedang tidak LIVE.`,
          );
      }
    } catch (error) {
      this.logger.error(`Gagal memproses aksi LIVE "${decision.action}": ${error?.message}`);
      return { ok: false, action: decision.action, error };
    }

    return { ok: true, action: decision.action };
  }

  /**
   * @param {import('../types.js').LiveStatus} status
   * @param {string|null} liveId
   * @private
   */
  async #handleNewSession(status, liveId) {
    this.logger.info(`LIVE baru terdeteksi untuk @${status.username}`, {
      liveId,
      title: status.title,
      viewers: status.viewers,
    });

    const result = await this.discord.sendLiveNotification(status);

    // State hanya ditandai setelah Discord menerima pesan. Kalau pengiriman
    // gagal, currentLiveId tidak berubah sehingga siklus berikutnya mencoba
    // lagi — lebih baik telat daripada sesi LIVE terlewat tanpa notifikasi.
    await this.store.update({
      currentLiveId: liveId,
      lastLiveStatus: true,
      liveStartedAt: status.startedAt ?? new Date().toISOString(),
      liveMessageId: result?.id ?? null,
      lastLiveUpdateAt: new Date().toISOString(),
      lastViewerCount: status.viewers,
    });
  }

  /**
   * @param {import('../types.js').LiveStatus} status
   * @private
   */
  async #handleViewerUpdate(status) {
    const state = this.store.get();
    const updated = await this.discord.updateLiveNotification(state.liveMessageId, status);

    await this.store.update({
      lastLiveUpdateAt: new Date().toISOString(),
      lastViewerCount: status.viewers,
      // Kalau pesan sudah tidak ada (dihapus manual), berhenti mencoba mengeditnya.
      liveMessageId: updated ? state.liveMessageId : null,
    });
  }

  /**
   * @param {import('../types.js').LiveStatus} status
   * @private
   */
  async #handleSessionEnd(status) {
    const state = this.store.get();
    this.logger.info(`Sesi LIVE @${status.username} berakhir.`, {
      liveId: state.currentLiveId,
    });

    if (state.liveMessageId) {
      await this.discord.updateLiveNotification(
        state.liveMessageId,
        {
          ...status,
          title: status.title,
          startedAt: state.liveStartedAt,
          viewers: state.lastViewerCount,
        },
        { ended: true },
      );
    }

    await this.store.update({
      currentLiveId: null,
      lastLiveStatus: false,
      liveStartedAt: null,
      liveMessageId: null,
      lastLiveUpdateAt: null,
      lastViewerCount: null,
    });
  }
}
