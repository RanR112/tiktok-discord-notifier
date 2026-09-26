/**
 * Generator gambar kartu selamat datang.
 *
 * Pendekatan: bikin background asli (gradient + hiasan sederhana, bukan aset
 * pihak ketiga) lewat SVG, rasterisasi dengan `sharp`, lalu tempel avatar user
 * (di-crop bulat) dan teks nama di atasnya. Semua teks/bentuk lewat SVG karena
 * `sharp` sendiri tidak punya API teks — SVG dirender librsvg di baliknya.
 */

import sharp from 'sharp';
import { HttpError } from '../utils/errors.js';
import { fetchWithTimeout } from '../utils/http.js';

const WIDTH = 900;
const HEIGHT = 360;
const AVATAR_SIZE = 180;

/**
 * Membersihkan teks supaya aman disisipkan ke dalam SVG (mencegah markup dari
 * nickname user merusak struktur SVG atau menyuntik elemen lain).
 *
 * @param {string} text
 * @returns {string}
 */
function escapeSvgText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Background gradient + hiasan lingkaran samar. Warna mengikuti tema TikTok
 * (merah muda/cyan) supaya konsisten dengan notifikasi lain di project ini.
 *
 * @returns {Buffer}
 */
function buildBackgroundSvg() {
  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1a1a2e" />
          <stop offset="100%" stop-color="#16162a" />
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
      <circle cx="${WIDTH - 60}" cy="60" r="150" fill="#fe2c55" opacity="0.14" />
      <circle cx="80" cy="${HEIGHT - 40}" r="130" fill="#25f4ee" opacity="0.12" />
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Teks "Selamat Datang" + nama user + nama server, diposisikan di sebelah
 * kanan avatar.
 *
 * @param {{ displayName: string, guildName: string }} data
 * @returns {Buffer}
 */
function buildTextSvg({ displayName, guildName }) {
  const textX = 40 + AVATAR_SIZE + 50;
  const name = escapeSvgText(displayName).slice(0, 60);
  const guild = escapeSvgText(guildName).slice(0, 60);

  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <text x="${textX}" y="150" font-family="Arial, sans-serif" font-size="26"
            font-weight="700" fill="#fe2c55" letter-spacing="2">SELAMAT DATANG</text>
      <text x="${textX}" y="210" font-family="Arial, sans-serif" font-size="52"
            font-weight="800" fill="#ffffff">${name}</text>
      <text x="${textX}" y="260" font-family="Arial, sans-serif" font-size="24"
            fill="#9aa0b4">di server ${guild}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/** Mask lingkaran untuk avatar, dengan ring dua warna khas TikTok. */
function buildAvatarMaskSvg(size) {
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ffffff" />
    </svg>
  `;
  return Buffer.from(svg);
}

function buildAvatarRingSvg(size) {
  const r = size / 2 - 4;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#fe2c55" />
          <stop offset="100%" stop-color="#25f4ee" />
        </linearGradient>
      </defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#ring)" stroke-width="8" />
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Mengunduh avatar user dan meng-crop-nya jadi lingkaran.
 *
 * @param {string} avatarUrl
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function fetchCircularAvatar(avatarUrl, options = {}) {
  const response = await fetchWithTimeout(avatarUrl, { timeoutMs: options.timeoutMs ?? 10_000 });
  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} saat mengambil avatar user`, {
      status: response.status,
      retryable: false,
    });
  }
  const raw = Buffer.from(await response.arrayBuffer());

  return sharp(raw)
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
    .composite([{ input: buildAvatarMaskSvg(AVATAR_SIZE), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * Membuat kartu selamat datang lengkap sebagai buffer PNG.
 *
 * Kalau avatar gagal diunduh (mis. user menghapus akun sesaat setelah join,
 * atau network error), kartu TETAP dibuat tanpa avatar — welcome message
 * tidak boleh gagal total hanya karena satu gambar tidak bisa diambil.
 *
 * @param {{ displayName: string, avatarUrl: string, guildName: string }} data
 * @param {{ timeoutMs?: number, logger?: { warn: Function } }} [options]
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function buildWelcomeCard(data, options = {}) {
  const layers = [{ input: buildBackgroundSvg(), top: 0, left: 0 }];

  const avatarLeft = 40;
  const avatarTop = Math.round((HEIGHT - AVATAR_SIZE) / 2);

  try {
    const avatar = await fetchCircularAvatar(data.avatarUrl, { timeoutMs: options.timeoutMs });
    layers.push({ input: avatar, top: avatarTop, left: avatarLeft });
    layers.push({
      input: buildAvatarRingSvg(AVATAR_SIZE),
      top: avatarTop,
      left: avatarLeft,
    });
  } catch (error) {
    options.logger?.warn(`Avatar tidak bisa dimuat, kartu dibuat tanpa avatar: ${error?.message}`);
  }

  layers.push({ input: buildTextSvg(data), top: 0, left: 0 });

  return sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}
