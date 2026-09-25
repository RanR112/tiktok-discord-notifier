/**
 * Deteksi status LIVE.
 *
 * Sumber data: endpoint web publik yang dipakai halaman profil TikTok itu
 * sendiri untuk merender badge "LIVE":
 *
 *   GET https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=<username>
 *
 * Endpoint ini tidak butuh login, cookie, maupun signature — jadi tidak ada
 * mekanisme keamanan apa pun yang dilewati. Tetap saja ini endpoint internal
 * yang tidak berkontrak publik, sehingga bisa berubah sewaktu-waktu. Semua
 * pembacaan field dilakukan secara defensif.
 *
 * CATATAN PENTING HASIL VERIFIKASI:
 * Objek `data.liveRoom` TETAP ADA walaupun akun sedang offline — isinya sisa
 * dari siaran terakhir (judul, cover, startTime, bahkan roomId). Jadi indikator
 * LIVE yang benar adalah `data.user.status === 2`, BUKAN sekadar keberadaan
 * `liveRoom` atau `roomId`. Kalau ini salah, notifier akan menganggap akun
 * LIVE selamanya.
 */

import { getJson } from '../../utils/http.js';
import { ProviderUnavailableError } from '../../utils/errors.js';
import { safeUrl, toIsoTimestamp } from '../../utils/format.js';

/** Nilai `status` dari TikTok. 2 = sedang siaran, 4 = offline/selesai. */
export const ROOM_STATUS_LIVE = 2;

const ROOM_ENDPOINT = 'https://www.tiktok.com/api-live/user/room/';

/**
 * Mengubah response mentah endpoint room menjadi bentuk LiveStatus.
 * Dipisah dari bagian jaringan supaya mudah diuji.
 *
 * @param {any} payload
 * @param {string} username
 * @returns {import('../../types.js').LiveStatus}
 */
export function parseLiveRoomPayload(payload, username) {
  const data = payload?.data ?? {};
  const user = data.user ?? {};
  const room = data.liveRoom ?? {};

  const displayName = typeof user.nickname === 'string' && user.nickname ? user.nickname : null;
  const url = `https://www.tiktok.com/@${username}/live`;

  // Hanya `status === 2` yang berarti benar-benar sedang siaran.
  const isLive = user.status === ROOM_STATUS_LIVE || room.status === ROOM_STATUS_LIVE;

  if (!isLive) {
    return {
      username,
      displayName,
      isLive: false,
      liveId: null,
      title: null,
      viewers: null,
      url,
      thumbnail: null,
      startedAt: null,
      avatar: safeUrl(user.avatarMedium ?? user.avatarThumb ?? user.avatarLarger),
    };
  }

  const stats = room.liveRoomStats ?? {};
  const viewers =
    typeof stats.userCount === 'number' && Number.isFinite(stats.userCount) ? stats.userCount : null;

  return {
    username,
    displayName,
    isLive: true,
    liveId:
      (typeof user.roomId === 'string' && user.roomId) ||
      (typeof room.streamId === 'string' && room.streamId) ||
      null,
    title: typeof room.title === 'string' && room.title.trim() !== '' ? room.title.trim() : null,
    viewers,
    url,
    thumbnail: safeUrl(room.coverUrl ?? room.squareCoverImg),
    startedAt: toIsoTimestamp(room.startTime),
    avatar: safeUrl(user.avatarMedium ?? user.avatarThumb ?? user.avatarLarger),
  };
}

/**
 * Provider status LIVE.
 */
export class LiveProvider {
  /**
   * @param {{
   *   username: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ username, timeoutMs = 15_000, retries = 3, logger }) {
    this.username = username;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  get name() {
    return 'web-live-room';
  }

  /**
   * @returns {Promise<import('../../types.js').LiveStatus>}
   * @throws {ProviderUnavailableError} kalau TikTok tidak bisa dibaca
   */
  async getLiveStatus() {
    const url = `${ROOM_ENDPOINT}?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(this.username)}`;

    let payload;
    try {
      payload = await getJson(url, {
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        headers: { referer: `https://www.tiktok.com/@${this.username}/live` },
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `Percobaan ulang ${attempt} pengecekan LIVE dalam ${delayMs}ms: ${error.message}`,
          );
        },
      });
    } catch (error) {
      // Body HTML alih-alih JSON = kena halaman tantangan anti-bot TikTok.
      const looksLikeChallenge =
        typeof error?.body === 'string' && /wafchallengeid|<!DOCTYPE html/i.test(error.body);
      throw new ProviderUnavailableError(
        looksLikeChallenge
          ? 'TikTok membalas halaman verifikasi anti-bot, bukan data LIVE.'
          : `Tidak bisa membaca status LIVE dari TikTok: ${error?.message}`,
        { cause: error, reason: looksLikeChallenge ? 'challenge' : 'network' },
      );
    }

    if (payload?.statusCode !== 0 && payload?.status_code !== 0) {
      throw new ProviderUnavailableError(
        `TikTok membalas statusCode=${payload?.statusCode ?? payload?.status_code} (${payload?.message || 'tanpa pesan'})`,
        { reason: 'upstream' },
      );
    }

    if (!payload?.data?.user) {
      throw new ProviderUnavailableError(
        `Akun @${this.username} tidak ditemukan atau struktur response TikTok berubah.`,
        { reason: 'shape' },
      );
    }

    return parseLiveRoomPayload(payload, this.username);
  }
}
