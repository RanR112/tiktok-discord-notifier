/**
 * Content provider "official" — TikTok Display API resmi.
 *
 *   POST https://open.tiktokapis.com/v2/oauth/token/   (grant_type=refresh_token)
 *   POST https://open.tiktokapis.com/v2/video/list/    (scope: video.list)
 *   GET  https://open.tiktokapis.com/v2/user/info/     (scope: user.info.basic)
 *
 * Ini jalur paling stabil dan paling patuh ToS, karena berkontrak resmi dan
 * berversi. BATASAN BESARNYA: hanya bisa membaca akun yang sudah memberikan
 * izin OAuth kepada app kamu — yaitu akun milik sendiri. Provider ini TIDAK
 * bisa dipakai untuk memantau akun orang lain.
 *
 * Refresh token berlaku 365 hari sejak diterbitkan; setelah itu perlu
 * otorisasi ulang.
 */

import { HttpError, ProviderUnavailableError } from '../../../utils/errors.js';
import { fetchWithTimeout, isRetryableStatus, parseRetryAfter, withRetry } from '../../../utils/http.js';
import { safeUrl, toIsoTimestamp } from '../../../utils/format.js';

const TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/';
const VIDEO_LIST_ENDPOINT = 'https://open.tiktokapis.com/v2/video/list/';
const USER_INFO_ENDPOINT = 'https://open.tiktokapis.com/v2/user/info/';

/** Field video yang diminta — semuanya ada di spesifikasi Video Object. */
const VIDEO_FIELDS = [
  'id',
  'create_time',
  'cover_image_url',
  'share_url',
  'video_description',
  'title',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
].join(',');

/** Buffer agar token di-refresh sebelum benar-benar kedaluwarsa. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Mengubah Video Object resmi menjadi ContentItem.
 *
 * @param {any} raw
 * @param {{ username: string, displayName: string|null }} context
 * @returns {import('../../../types.js').ContentItem|null}
 */
export function mapOfficialVideo(raw, context) {
  const id = raw?.id != null ? String(raw.id) : null;
  if (!id) return null;

  const caption =
    (typeof raw.video_description === 'string' && raw.video_description.trim()) ||
    (typeof raw.title === 'string' && raw.title.trim()) ||
    null;

  return {
    id,
    username: context.username,
    displayName: context.displayName,
    caption,
    url:
      safeUrl(raw.share_url) ?? `https://www.tiktok.com/@${context.username}/video/${id}`,
    thumbnail: safeUrl(raw.cover_image_url),
    publishedAt: toIsoTimestamp(raw.create_time),
    views: num(raw.view_count),
    likes: num(raw.like_count),
    comments: num(raw.comment_count),
    shares: num(raw.share_count),
    source: 'official',
  };
}

export class OfficialContentProvider {
  /**
   * @param {{
   *   username: string,
   *   clientKey: string,
   *   clientSecret: string,
   *   refreshToken: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../../../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ username, clientKey, clientSecret, refreshToken, timeoutMs = 15_000, retries = 3, logger }) {
    this.username = username;
    this.clientKey = clientKey;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;

    /** @type {string|null} */
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    /** @type {string|null} */
    this.displayName = null;
  }

  get name() {
    return 'official';
  }

  get bestEffort() {
    return false;
  }

  /**
   * Menukar refresh token dengan access token, dengan cache di memori.
   * @returns {Promise<string>}
   * @private
   */
  async #getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    const payload = await withRetry(
      async () => {
        const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cache-control': 'no-cache',
          },
          body: body.toString(),
          timeoutMs: this.timeoutMs,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new HttpError(`HTTP ${response.status} saat refresh access token`, {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            retryAfterMs: parseRetryAfter(response.headers),
            body: text.slice(0, 300),
          });
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError('Response token bukan JSON yang valid', { retryable: false });
        }
      },
      { retries: this.retries },
    );

    if (payload?.error) {
      throw new ProviderUnavailableError(
        `TikTok menolak refresh token: ${payload.error} — ${payload.error_description ?? ''}`.trim(),
        { reason: 'auth' },
      );
    }
    if (typeof payload?.access_token !== 'string') {
      throw new ProviderUnavailableError('Response token tidak memuat access_token.', {
        reason: 'shape',
      });
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (num(payload.expires_in) ?? 3600) * 1000;

    if (typeof payload.refresh_token === 'string' && payload.refresh_token !== this.refreshToken) {
      // TikTok bisa memutar refresh token. Yang di memori dipakai untuk sesi ini;
      // yang di .env perlu diperbarui manual agar tetap valid setelah restart.
      this.refreshToken = payload.refresh_token;
      this.logger.warn(
        'TikTok menerbitkan refresh token baru. Perbarui TIKTOK_REFRESH_TOKEN di .env ' +
          'agar tetap bekerja setelah restart. (Nilainya tidak ditulis ke log.)',
      );
    }

    return this.accessToken;
  }

  /**
   * @param {string} accessToken
   * @returns {Promise<string|null>}
   * @private
   */
  async #getDisplayName(accessToken) {
    if (this.displayName) return this.displayName;
    try {
      const response = await fetchWithTimeout(
        `${USER_INFO_ENDPOINT}?fields=open_id,display_name,avatar_url`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${accessToken}` },
          timeoutMs: this.timeoutMs,
        },
      );
      if (!response.ok) return null;
      const payload = await response.json();
      const name = payload?.data?.user?.display_name;
      this.displayName = typeof name === 'string' && name ? name : null;
      return this.displayName;
    } catch {
      return null;
    }
  }

  /**
   * @returns {Promise<import('../../../types.js').ContentItem[]>} terbaru lebih dulu
   */
  async getLatestContent() {
    const accessToken = await this.#getAccessToken();
    const displayName = await this.#getDisplayName(accessToken);

    const payload = await withRetry(
      async () => {
        const response = await fetchWithTimeout(`${VIDEO_LIST_ENDPOINT}?fields=${VIDEO_FIELDS}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ max_count: 20 }),
          timeoutMs: this.timeoutMs,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new HttpError(`HTTP ${response.status} dari /v2/video/list/`, {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            retryAfterMs: parseRetryAfter(response.headers),
            body: text.slice(0, 300),
          });
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError('Response video list bukan JSON yang valid', { retryable: false });
        }
      },
      { retries: this.retries },
    );

    const errorCode = payload?.error?.code;
    if (errorCode && errorCode !== 'ok') {
      throw new ProviderUnavailableError(
        `Display API error: ${errorCode} — ${payload.error.message ?? ''}`.trim(),
        { reason: 'upstream' },
      );
    }

    const videos = payload?.data?.videos;
    if (!Array.isArray(videos)) {
      throw new ProviderUnavailableError('Response Display API tidak memuat data.videos.', {
        reason: 'shape',
      });
    }

    return videos
      .map((video) => mapOfficialVideo(video, { username: this.username, displayName }))
      .filter(Boolean)
      .sort((a, b) => {
        const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return bt - at;
      });
  }
}
