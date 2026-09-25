/**
 * TikTok oEmbed — satu-satunya endpoint TikTok yang RESMI didokumentasikan dan
 * bisa dipakai tanpa autentikasi:
 *
 *   https://developers.tiktok.com/doc/embed-videos
 *   GET https://www.tiktok.com/oembed?url=<url video>
 *
 * Yang diberikan: title (caption), author_name (display name), thumbnail_url.
 * Yang TIDAK diberikan: statistik (views/likes/comments/shares) dan daftar
 * video. Jadi oEmbed hanya dipakai untuk MELENGKAPI item yang id-nya sudah
 * diketahui, bukan untuk menemukan video baru.
 */

import { getJson } from '../../utils/http.js';
import { safeUrl } from '../../utils/format.js';

const OEMBED_ENDPOINT = 'https://www.tiktok.com/oembed';

/**
 * @param {string} videoUrl
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<{ caption: string|null, displayName: string|null, thumbnail: string|null }|null>}
 *          null kalau oEmbed tidak bisa dipakai (video privat/terhapus/endpoint error)
 */
export async function fetchOembed(videoUrl, options = {}) {
  const { timeoutMs = 15_000, retries = 1 } = options;
  const url = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(videoUrl)}`;

  try {
    const payload = await getJson(url, { timeoutMs, retries });
    return {
      caption: typeof payload?.title === 'string' && payload.title ? payload.title : null,
      displayName:
        typeof payload?.author_name === 'string' && payload.author_name ? payload.author_name : null,
      thumbnail: safeUrl(payload?.thumbnail_url),
    };
  } catch {
    // Enrichment bersifat opsional — kegagalannya tidak boleh membatalkan notifikasi.
    return null;
  }
}
