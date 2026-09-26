/**
 * State persisten anti-duplikat.
 *
 * Ditulis secara atomik (tulis ke file sementara lalu rename) supaya file tidak
 * pernah setengah jadi kalau proses dimatikan di tengah penulisan — state yang
 * korup berarti notifikasi duplikat setelah restart.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Berapa banyak id video lama yang diingat untuk keperluan dedup. */
export const KNOWN_CONTENT_LIMIT = 100;

export const STATE_VERSION = 1;

/** @returns {import('../types.js').AppState} */
export function createDefaultState() {
  return {
    version: STATE_VERSION,

    // --- Konten ---
    lastContentId: null,
    knownContentIds: [],
    /** false = belum pernah sinkron. Siklus pertama hanya merekam, tidak mengirim. */
    contentBootstrapped: false,

    // --- LIVE ---
    currentLiveId: null,
    lastLiveStatus: false,
    liveStartedAt: null,
    liveMessageId: null,
    lastLiveUpdateAt: null,
    lastViewerCount: null,

    // --- Welcome member ---
    // TIDAK dibatasi ring buffer seperti knownContentIds: harus tetap memuat
    // SEMUA member yang pernah tercatat, selama-lamanya server itu berjalan.
    // Kalau dibatasi, member lama yang jumlahnya melebihi batas akan
    // "terlupakan" dan disambut ulang secara keliru walau tidak pernah keluar.
    knownMemberIds: [],
    /** false = belum pernah sinkron. Siklus pertama hanya merekam, tidak menyambut. */
    memberBootstrapped: false,

    // --- Umum ---
    lastCheckedAt: null,
  };
}

/**
 * Menggabungkan state dari disk dengan default, membuang field asing dan
 * memperbaiki tipe yang salah. Isi file di disk tidak pernah dipercaya
 * bulat-bulat.
 *
 * @param {unknown} raw
 * @returns {import('../types.js').AppState}
 */
export function normalizeState(raw) {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const input = /** @type {Record<string, unknown>} */ (raw);
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

  const knownContentIds = Array.isArray(input.knownContentIds)
    ? input.knownContentIds.filter((id) => typeof id === 'string' && id !== '')
    : [];

  const lastContentId = str(input.lastContentId);

  const knownMemberIds = Array.isArray(input.knownMemberIds)
    ? [...new Set(input.knownMemberIds.filter((id) => typeof id === 'string' && id !== ''))]
    : [];

  return {
    version: STATE_VERSION,
    lastContentId,
    knownContentIds: knownContentIds.slice(-KNOWN_CONTENT_LIMIT),
    // Kompatibel mundur: state lama tanpa flag ini tapi sudah punya id video
    // dianggap sudah ter-bootstrap, supaya upgrade tidak membanjiri channel.
    contentBootstrapped:
      typeof input.contentBootstrapped === 'boolean'
        ? input.contentBootstrapped
        : knownContentIds.length > 0 || lastContentId !== null,
    currentLiveId: str(input.currentLiveId),
    lastLiveStatus: input.lastLiveStatus === true,
    liveStartedAt: str(input.liveStartedAt),
    liveMessageId: str(input.liveMessageId),
    lastLiveUpdateAt: str(input.lastLiveUpdateAt),
    lastViewerCount:
      typeof input.lastViewerCount === 'number' && Number.isFinite(input.lastViewerCount)
        ? input.lastViewerCount
        : null,
    knownMemberIds,
    memberBootstrapped:
      typeof input.memberBootstrapped === 'boolean'
        ? input.memberBootstrapped
        : knownMemberIds.length > 0,
    lastCheckedAt: str(input.lastCheckedAt),
  };
}

/**
 * Menambahkan id konten ke daftar yang diingat, menjaga urutan dan batas.
 * Fungsi murni: mengembalikan array baru.
 *
 * @param {string[]} known
 * @param {string[]} newIds
 * @returns {string[]}
 */
export function rememberContentIds(known, newIds) {
  const merged = [...known];
  for (const id of newIds) {
    if (typeof id !== 'string' || id === '') continue;
    if (!merged.includes(id)) merged.push(id);
  }
  return merged.slice(-KNOWN_CONTENT_LIMIT);
}

/**
 * Menambahkan id member ke daftar yang diingat. TIDAK dibatasi ukuran
 * (beda dari `rememberContentIds`) -- lihat catatan di `createDefaultState`.
 * Fungsi murni: mengembalikan array baru.
 *
 * @param {string[]} known
 * @param {string[]} newIds
 * @returns {string[]}
 */
export function rememberMemberIds(known, newIds) {
  const merged = [...known];
  for (const id of newIds) {
    if (typeof id !== 'string' || id === '') continue;
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

/**
 * Penyimpan state berbasis file JSON.
 */
export class StateStore {
  /**
   * @param {string} filePath
   * @param {{ logger?: { warn: Function, debug: Function, error: Function } }} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
    this.logger = options.logger;
    /** @type {import('../types.js').AppState} */
    this.state = createDefaultState();
    this.loaded = false;
  }

  /**
   * Membaca state dari disk. File hilang atau korup TIDAK menggagalkan startup:
   * aplikasi melanjutkan dengan state default (dan mem-bootstrap ulang, sehingga
   * channel tidak dibanjiri video lama).
   *
   * @returns {Promise<import('../types.js').AppState>}
   */
  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
      this.logger?.debug('State dimuat dari disk', {
        file: this.filePath,
        knownContent: this.state.knownContentIds.length,
        currentLiveId: this.state.currentLiveId,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.logger?.debug('File state belum ada, memakai state default', {
          file: this.filePath,
        });
      } else {
        this.logger?.warn(
          `File state tidak bisa dibaca (${error?.message}). Memakai state default.`,
          { file: this.filePath },
        );
      }
      this.state = createDefaultState();
    }
    this.loaded = true;
    return this.state;
  }

  /** @returns {import('../types.js').AppState} */
  get() {
    return this.state;
  }

  /**
   * Menerapkan perubahan lalu langsung menyimpannya ke disk.
   *
   * @param {Partial<import('../types.js').AppState>} patch
   */
  async update(patch) {
    this.state = { ...this.state, ...patch };
    await this.save();
    return this.state;
  }

  /**
   * Menulis state secara atomik. Kegagalan penulisan dicatat sebagai ERROR tapi
   * tidak dilempar — kehilangan satu penulisan state tidak boleh menjatuhkan
   * proses monitoring.
   */
  async save() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.tmpPath, payload, 'utf8');
      await rename(this.tmpPath, this.filePath);
    } catch (error) {
      this.logger?.error(`Gagal menyimpan state: ${error?.message}`, {
        file: this.filePath,
      });
      await unlink(this.tmpPath).catch(() => {});
    }
  }
}
