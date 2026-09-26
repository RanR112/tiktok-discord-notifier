/**
 * Discord Bot REST client — terpisah total dari discord.js (webhook service).
 *
 * Webhook cuma bisa MENGIRIM pesan (satu arah). Untuk tahu SIAPA yang baru
 * join server, aplikasi perlu membaca daftar member lewat REST API, dan itu
 * butuh Bot Token (bukan URL webhook) yang di-invite ke server dengan
 * privileged intent "Server Members" diaktifkan di Developer Portal.
 *
 * Referensi resmi: https://discord.com/developers/docs/resources/guild
 * (List Guild Members) dan .../resources/message (Create Message, multipart).
 */

import { HttpError } from '../utils/errors.js';
import { fetchWithTimeout, isRetryableStatus, parseRetryAfter, withRetry } from '../utils/http.js';

const API_BASE = 'https://discord.com/api/v10';

/** Maksimum member per halaman sesuai batas Discord. */
const MEMBERS_PAGE_SIZE = 1000;

/**
 * User-Agent JUJUR sesuai format yang direkomendasikan Discord sendiri
 * (`DiscordBot ($url, $version)`). Ini PENTING dan bukan sekadar formalitas:
 * `fetchWithTimeout` di utils/http.js secara default mengirim User-Agent
 * PALSU ala Chrome (sengaja, untuk endpoint TikTok agar tidak diblokir WAF).
 * Kalau dipakai apa adanya ke Discord API, Discord API JUSTRU MENOLAKNYA
 * dengan HTTP 403 (code 40333 "internal network error") -- proteksi mereka
 * mendeteksi Bot Token dipakai bersama User-Agent yang menyamar sebagai
 * browser sebagai pola mencurigakan. Header ini di bawah meng-override
 * default itu supaya request ke Discord selalu jujur.
 */
const DISCORD_USER_AGENT =
  'DiscordBot (https://github.com/RanR112/tiktok-discord-notifier, 1.0.0)';

/**
 * Membentuk URL avatar CDN Discord, dengan fallback ke default avatar kalau
 * user tidak punya avatar custom.
 *
 * @param {{ id: string, avatar: string|null, discriminator?: string }} user
 * @returns {string}
 */
export function buildAvatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  // Sistem username baru (tanpa diskriminator #0000): index dari user id.
  // eslint-disable-next-line no-bitwise
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Mengubah Guild Member Object mentah dari Discord menjadi bentuk yang dipakai
 * di seluruh aplikasi.
 *
 * @param {any} raw
 * @returns {import('../types.js').GuildMember|null}
 */
export function mapGuildMember(raw) {
  const user = raw?.user;
  if (!user?.id) return null;

  return {
    id: String(user.id),
    username: typeof user.username === 'string' ? user.username : 'unknown',
    displayName:
      (typeof raw.nick === 'string' && raw.nick) ||
      (typeof user.global_name === 'string' && user.global_name) ||
      null,
    avatarUrl: buildAvatarUrl({ id: String(user.id), avatar: raw.avatar ?? user.avatar ?? null }),
    joinedAt: typeof raw.joined_at === 'string' ? raw.joined_at : null,
  };
}

export class DiscordBotService {
  /**
   * @param {{
   *   botToken: string,
   *   timeoutMs?: number,
   *   retries?: number,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ botToken, timeoutMs = 15_000, retries = 3, logger }) {
    this.botToken = botToken;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  /**
   * @param {string} path diawali "/"
   * @returns {Record<string, string>}
   * @private
   */
  #headers(extra = {}) {
    return {
      authorization: `Bot ${this.botToken}`,
      'user-agent': DISCORD_USER_AGENT,
      ...extra,
    };
  }

  /**
   * Mengambil nama server (dipakai untuk teks kartu welcome).
   *
   * @param {string} guildId
   * @returns {Promise<string|null>} null kalau gagal -- bukan error fatal,
   *          pemanggil cukup memakai teks generik sebagai fallback.
   */
  async getGuildName(guildId) {
    try {
      const response = await fetchWithTimeout(`${API_BASE}/guilds/${guildId}`, {
        method: 'GET',
        headers: this.#headers(),
        timeoutMs: this.timeoutMs,
      });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body?.name === 'string' ? body.name : null;
    } catch {
      return null;
    }
  }

  /**
   * Mengambil SELURUH member server (dengan pagination otomatis).
   * Butuh privileged intent "Server Members" aktif di Developer Portal --
   * kalau tidak, Discord membalas 403 dengan pesan yang jelas soal intent.
   *
   * @param {string} guildId
   * @returns {Promise<import('../types.js').GuildMember[]>}
   */
  async listGuildMembers(guildId) {
    /** @type {import('../types.js').GuildMember[]} */
    const members = [];
    let after = '0';

    for (;;) {
      const url = `${API_BASE}/guilds/${guildId}/members?limit=${MEMBERS_PAGE_SIZE}&after=${after}`;

      const page = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: this.#headers(),
            timeoutMs: this.timeoutMs,
          });
          const text = await response.text();

          if (!response.ok) {
            const hint =
              response.status === 403
                ? ' Kemungkinan privileged intent "Server Members" belum diaktifkan di Discord Developer Portal, atau bot belum di-invite ke server ini.'
                : '';
            throw new HttpError(`HTTP ${response.status} saat membaca member server.${hint}`, {
              status: response.status,
              retryable: isRetryableStatus(response.status),
              retryAfterMs: parseRetryAfter(response.headers),
              body: text.slice(0, 300),
            });
          }

          try {
            return JSON.parse(text);
          } catch {
            throw new HttpError('Response daftar member bukan JSON yang valid', { retryable: false });
          }
        },
        {
          retries: this.retries,
          onRetry: ({ attempt, delayMs, error }) => {
            this.logger.warn(
              `Percobaan ulang ${attempt} baca member server dalam ${delayMs}ms: ${error.message}`,
            );
          },
        },
      );

      if (!Array.isArray(page) || page.length === 0) break;

      for (const raw of page) {
        const member = mapGuildMember(raw);
        if (member) members.push(member);
      }

      if (page.length < MEMBERS_PAGE_SIZE) break;
      after = String(page.at(-1)?.user?.id ?? after);
    }

    return members;
  }

  /**
   * Mengirim pesan ke channel lewat Bot Token, dengan lampiran gambar
   * (multipart/form-data). Dipakai untuk pesan selamat datang bergambar.
   *
   * @param {string} channelId
   * @param {{
   *   embeds?: object[],
   *   content?: string,
   *   file?: { buffer: Buffer, filename: string, contentType: string },
   * }} payload
   * @returns {Promise<{ id: string|null }>}
   */
  async sendChannelMessage(channelId, payload) {
    const { file, ...jsonPayload } = payload;

    const form = new FormData();
    form.append('payload_json', JSON.stringify(jsonPayload));
    if (file) {
      form.append(
        'files[0]',
        new Blob([file.buffer], { type: file.contentType }),
        file.filename,
      );
    }

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(`${API_BASE}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: this.#headers(),
          body: form,
          timeoutMs: this.timeoutMs,
        });
        const text = await response.text();

        if (!response.ok) {
          const hint =
            response.status === 403
              ? ' Bot mungkin tidak punya izin "Send Messages"/"Attach Files" di channel ini.'
              : '';
          throw new HttpError(`HTTP ${response.status} saat kirim pesan welcome.${hint}`, {
            status: response.status,
            retryable: isRetryableStatus(response.status),
            retryAfterMs: parseRetryAfter(response.headers),
            body: text.slice(0, 300),
          });
        }

        try {
          const body = JSON.parse(text);
          return { id: body?.id ?? null };
        } catch {
          return { id: null };
        }
      },
      {
        retries: this.retries,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `Percobaan ulang ${attempt} kirim pesan welcome dalam ${delayMs}ms: ${error.message}`,
          );
        },
      },
    );
  }
}
