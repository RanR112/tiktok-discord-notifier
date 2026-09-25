/**
 * Helper format untuk isi embed Discord.
 */

/**
 * 1234 -> "1,234". Mengembalikan null kalau angkanya tidak tersedia, supaya
 * pemanggil bisa MENGHILANGKAN field-nya, bukan menampilkan "0" yang palsu.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value).toLocaleString('en-US');
}

/**
 * Memotong teks agar muat di batas Discord, dengan elipsis.
 *
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  const str = typeof text === 'string' ? text.trim() : '';
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Mengubah epoch detik / milliseconds / ISO string menjadi ISO-8601 yang
 * dipahami Discord. Mengembalikan null kalau tidak valid.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function toIsoTimestamp(value) {
  if (value == null) return null;

  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch detik (10 digit) vs milliseconds (13 digit).
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const asNumber = Number(trimmed);
    date = Number.isFinite(asNumber)
      ? new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber)
      : new Date(trimmed);
  } else if (value instanceof Date) {
    date = value;
  } else {
    return null;
  }

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Memastikan sebuah URL aman dipakai di embed (hanya http/https). Discord
 * menolak SELURUH payload kalau ada satu URL tidak valid, jadi lebih baik
 * disaring lebih dulu di sini.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Membersihkan username: buang '@', spasi, dan URL profil kalau pengguna
 * terlanjur menempelkan link lengkap di .env.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUsername(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '')
    .trim();
}
