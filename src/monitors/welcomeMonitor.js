/**
 * Monitor sambutan member baru.
 *
 * Cara kerja: cek daftar member server secara berkala, bandingkan dengan
 * daftar member yang sudah diketahui (`state.knownMemberIds`), sambut yang
 * belum pernah tercatat. Pola anti-duplikatnya SAMA seperti contentMonitor:
 *
 * 1. Siklus pertama (`memberBootstrapped: false`) hanya MEREKAM seluruh
 *    member yang sudah ada, TANPA menyambut siapa pun. Tanpa ini, instalasi
 *    baru akan menyambut ratusan member lama sekaligus seolah baru join.
 * 2. Setelahnya, hanya id yang belum pernah tercatat yang disambut.
 * 3. `knownMemberIds` TIDAK dibatasi ring buffer (beda dari knownContentIds) --
 *    lihat catatan di utils/state.js.
 *
 * Catatan penting: endpoint List Guild Members Discord mengurutkan berdasar
 * user id, BUKAN waktu join. Supaya beberapa member yang join berdekatan
 * tetap disambut sesuai urutan sungguhan, kandidat diurutkan ulang berdasar
 * `joinedAt` sebelum dipotong ke MAX_PER_CYCLE.
 */

import { rememberMemberIds } from '../utils/state.js';
import { buildWelcomeCard } from '../services/welcomeImage.js';

/**
 * Keputusan murni: member mana yang perlu disambut.
 *
 * @param {import('../types.js').GuildMember[]} members
 * @param {import('../types.js').AppState} state
 * @param {{ maxPerCycle?: number }} [options]
 * @returns {{
 *   toWelcome: import('../types.js').GuildMember[],
 *   allIds: string[],
 *   skipped: number,
 *   bootstrap: boolean,
 * }}
 */
export function selectNewMembers(members, state, options = {}) {
  const { maxPerCycle = 5 } = options;
  const allIds = members.map((m) => m.id);

  if (!state.memberBootstrapped) {
    return { toWelcome: [], allIds, skipped: 0, bootstrap: true };
  }

  const known = new Set(state.knownMemberIds);
  const fresh = members
    .filter((m) => !known.has(m.id))
    // Urutkan berdasar waktu join sungguhan (list API tidak menjamin urutan
    // ini); member tanpa joinedAt (jarang terjadi) ditaruh di akhir.
    .sort((a, b) => {
      const at = a.joinedAt ? Date.parse(a.joinedAt) : Infinity;
      const bt = b.joinedAt ? Date.parse(b.joinedAt) : Infinity;
      return at - bt;
    });

  const selected = fresh.slice(0, maxPerCycle);

  return {
    toWelcome: selected,
    allIds,
    skipped: Math.max(0, fresh.length - selected.length),
    bootstrap: false,
  };
}

/** Warna embed welcome, senada dengan tema TikTok di notifikasi lain. */
const COLOR_WELCOME = 0xfe2c55;

export class WelcomeMonitor {
  /**
   * @param {{
   *   discordBot: import('../services/discordBot.js').DiscordBotService,
   *   store: import('../utils/state.js').StateStore,
   *   config: any,
   *   logger: ReturnType<typeof import('../utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ discordBot, store, config, logger }) {
    this.discordBot = discordBot;
    this.store = store;
    this.config = config;
    this.logger = logger;
    /** @type {string|null} */
    this.guildName = null;
  }

  get name() {
    return 'welcome';
  }

  /**
   * Satu siklus pengecekan member. Selalu resolve, tidak pernah melempar --
   * sama seperti monitor lain, kegagalan di sini tidak boleh menghentikan yang lain.
   *
   * @returns {Promise<{ ok: boolean, welcomed?: number, error?: Error }>}
   */
  async check() {
    this.logger.info('Mengecek member baru di server...');

    // Diambil sekali per proses, di-cache -- tidak perlu query ulang tiap
    // siklus hanya untuk nama server yang jarang berubah.
    if (this.guildName === null) {
      this.guildName = await this.discordBot.getGuildName(this.config.welcome.guildId);
    }

    /** @type {import('../types.js').GuildMember[]} */
    let members;
    try {
      members = await this.discordBot.listGuildMembers(this.config.welcome.guildId);
    } catch (error) {
      this.logger.error(`Gagal membaca daftar member: ${error?.message}`);
      return { ok: false, error };
    }

    if (members.length === 0) {
      this.logger.warn('Daftar member kosong -- dilewati (kemungkinan bot belum di-invite dengan benar).');
      return { ok: true, welcomed: 0 };
    }

    const state = this.store.get();
    const { toWelcome, allIds, skipped, bootstrap } = selectNewMembers(members, state, {
      maxPerCycle: this.config.welcome.maxPerCycle,
    });

    if (bootstrap) {
      await this.store.update({
        knownMemberIds: rememberMemberIds(state.knownMemberIds, allIds),
        memberBootstrapped: true,
      });
      this.logger.info(
        `Sinkronisasi awal selesai: ${allIds.length} member direkam sebagai "sudah dikenal". ` +
          'Tidak ada sambutan dikirim. Member berikutnya yang join akan disambut.',
      );
      return { ok: true, welcomed: 0 };
    }

    if (toWelcome.length === 0) {
      this.logger.info('Tidak ada member baru.');
      await this.store.update({ knownMemberIds: rememberMemberIds(state.knownMemberIds, allIds) });
      return { ok: true, welcomed: 0 };
    }

    if (skipped > 0) {
      this.logger.warn(
        `${skipped} member baru lainnya dilewati pada siklus ini (batas WELCOME_MAX_PER_CYCLE=${this.config.welcome.maxPerCycle}). ` +
          'Mereka ditandai sudah dikenal dan TIDAK akan disambut di siklus berikutnya -- ' +
          'ini trade-off yang disengaja agar channel tidak dibanjiri saat banyak yang join sekaligus.',
      );
    }

    let welcomed = 0;
    /** @type {Error|null} */
    let sendError = null;
    for (const member of toWelcome) {
      try {
        await this.#sendWelcome(member);
        welcomed += 1;
        await this.store.update({
          knownMemberIds: rememberMemberIds(this.store.get().knownMemberIds, [member.id]),
        });
      } catch (error) {
        sendError = error;
        this.logger.error(
          `Gagal mengirim sambutan untuk member ${member.id} (${member.username}): ${error?.message}. ` +
            'Akan dicoba lagi pada siklus berikutnya.',
        );
        break;
      }
    }

    if (skipped > 0) {
      await this.store.update({
        knownMemberIds: rememberMemberIds(this.store.get().knownMemberIds, allIds),
      });
    }

    if (sendError) {
      this.logger.warn(
        `${welcomed}/${toWelcome.length} sambutan terkirim; sisanya tertunda ke siklus berikutnya.`,
      );
      return { ok: false, welcomed, error: sendError };
    }

    this.logger.info(`${welcomed} sambutan member terkirim.`);
    return { ok: true, welcomed };
  }

  /**
   * @param {import('../types.js').GuildMember} member
   * @private
   */
  async #sendWelcome(member) {
    const displayName = member.displayName || member.username;
    const filename = 'welcome.png';

    let buffer;
    try {
      buffer = await buildWelcomeCard(
        { displayName, avatarUrl: member.avatarUrl, guildName: this.guildName ?? 'server ini' },
        { timeoutMs: this.config.requestTimeout, logger: this.logger },
      );
    } catch (error) {
      // Kartu gagal dibuat total (bukan cuma avatarnya) -- tetap kirim
      // sambutan TEKS saja daripada tidak menyambut sama sekali.
      this.logger.warn(`Gagal membuat kartu welcome, kirim teks saja: ${error?.message}`);
      await this.discordBot.sendChannelMessage(this.config.welcome.channelId, {
        content: `👋 Selamat datang, <@${member.id}>!`,
      });
      return;
    }

    await this.discordBot.sendChannelMessage(this.config.welcome.channelId, {
      content: `👋 Selamat datang, <@${member.id}>!`,
      embeds: [
        {
          color: COLOR_WELCOME,
          image: { url: `attachment://${filename}` },
        },
      ],
      file: { buffer, filename, contentType: 'image/png' },
    });

    this.logger.info(`Sambutan terkirim untuk ${member.username} (${member.id}).`);
  }
}
