/**
 * Definisi tipe bersama (JSDoc saja — tidak ada kode runtime di sini).
 *
 * Project ini sengaja memakai JavaScript, bukan TypeScript. JSDoc memberi
 * autocomplete dan pengecekan tipe di editor tanpa menambah build step,
 * sehingga `npm start` langsung menjalankan source aslinya.
 */

/**
 * @typedef {Object} AppState
 * @property {number}        version
 * @property {string|null}   lastContentId       Id video terbaru yang sudah dinotifikasi.
 * @property {string[]}      knownContentIds     Ring buffer id video yang sudah pernah dilihat.
 * @property {boolean}       contentBootstrapped Sudah pernah sinkron awal? Kalau belum, siklus pertama hanya merekam.
 * @property {string|null}   currentLiveId       roomId sesi LIVE yang sedang berjalan.
 * @property {boolean}       lastLiveStatus      Status LIVE pada pengecekan terakhir.
 * @property {string|null}   liveStartedAt       ISO timestamp mulainya sesi LIVE saat ini.
 * @property {string|null}   liveMessageId       Id pesan Discord untuk sesi LIVE saat ini (dipakai untuk edit).
 * @property {string|null}   lastLiveUpdateAt    ISO timestamp update penonton terakhir.
 * @property {number|null}   lastViewerCount     Jumlah penonton pada update terakhir.
 * @property {string|null}   lastCheckedAt       ISO timestamp siklus pengecekan terakhir.
 */

/**
 * Hasil `tiktokService.getLiveStatus()`.
 *
 * @typedef {Object} LiveStatus
 * @property {string}       username
 * @property {string|null}  displayName
 * @property {boolean}      isLive
 * @property {string|null}  liveId      roomId TikTok; pembeda antar sesi LIVE.
 * @property {string|null}  title
 * @property {number|null}  viewers
 * @property {string}       url
 * @property {string|null}  thumbnail
 * @property {string|null}  startedAt   ISO-8601.
 * @property {string|null}  avatar
 */

/**
 * Satu item konten dari `tiktokService.getLatestContent()`.
 *
 * Field statistik bisa bernilai null kalau provider tidak menyediakannya —
 * field null TIDAK ditampilkan di embed, agar tidak memunculkan angka palsu.
 *
 * @typedef {Object} ContentItem
 * @property {string}       id
 * @property {string}       username
 * @property {string|null}  displayName
 * @property {string|null}  caption
 * @property {string}       url
 * @property {string|null}  thumbnail
 * @property {string|null}  publishedAt ISO-8601.
 * @property {number|null}  views
 * @property {number|null}  likes
 * @property {number|null}  comments
 * @property {number|null}  shares
 * @property {string}       source      Nama provider yang menghasilkan item ini.
 */

export {};
