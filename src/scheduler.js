/**
 * Loop polling.
 *
 * Alur: load config -> load state -> cek LIVE -> cek content -> tunggu
 * CHECK_INTERVAL -> ulangi.
 *
 * LIVE dan content dijalankan lewat `Promise.allSettled`, jadi kegagalan salah
 * satunya tidak pernah membatalkan yang lain dan tidak pernah menghentikan loop.
 * Jeda dihitung SETELAH siklus selesai, sehingga siklus yang lambat tidak
 * menumpuk request.
 */

export class Scheduler {
  /**
   * @param {{
   *   monitors: Array<{ name: string, check: () => Promise<any> }>,
   *   store: import('./utils/state.js').StateStore,
   *   intervalMs: number,
   *   logger: ReturnType<typeof import('./utils/logger.js').createLogger>,
   * }} options
   */
  constructor({ monitors, store, intervalMs, logger }) {
    this.monitors = monitors;
    this.store = store;
    this.intervalMs = intervalMs;
    this.logger = logger;

    this.running = false;
    this.cycle = 0;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {(() => void)|null} */
    this.wakeUp = null;
  }

  /**
   * Menjalankan semua monitor satu kali, saling terisolasi.
   * @returns {Promise<void>}
   */
  async runOnce() {
    this.cycle += 1;
    const startedAt = Date.now();
    this.logger.info(`--- Siklus #${this.cycle} dimulai ---`);

    const results = await Promise.allSettled(
      this.monitors.map(async (monitor) => {
        try {
          return { monitor: monitor.name, result: await monitor.check() };
        } catch (error) {
          // Jaring pengaman: monitor seharusnya sudah menangani error-nya sendiri.
          this.logger.error(
            `Monitor "${monitor.name}" melempar error yang tidak tertangani: ${error?.message}`,
          );
          return { monitor: monitor.name, result: { ok: false, error } };
        }
      }),
    );

    const failed = results.filter(
      (r) => r.status === 'rejected' || r.value?.result?.ok === false,
    ).length;

    await this.store.update({ lastCheckedAt: new Date().toISOString() });

    const durationMs = Date.now() - startedAt;
    const summary = `${this.monitors.length - failed}/${this.monitors.length} monitor sukses`;
    this.logger.info(`--- Siklus #${this.cycle} selesai dalam ${durationMs}ms (${summary}) ---`);
  }

  /**
   * Menjalankan loop sampai `stop()` dipanggil.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      `Monitoring dimulai. Interval pengecekan: ${this.intervalMs}ms (${Math.round(this.intervalMs / 1000)} detik).`,
    );

    while (this.running) {
      await this.runOnce();
      if (!this.running) break;
      await this.#wait(this.intervalMs);
    }

    this.logger.info('Loop monitoring berhenti.');
  }

  /**
   * Jeda yang bisa dibatalkan, supaya Ctrl+C langsung direspons dan tidak
   * harus menunggu sisa interval.
   *
   * @param {number} ms
   * @private
   */
  #wait(ms) {
    return new Promise((resolve) => {
      this.wakeUp = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wakeUp = null;
        resolve();
      };
      this.timer = setTimeout(this.wakeUp, ms);
    });
  }

  /** Menghentikan loop setelah siklus berjalan saat ini selesai. */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.wakeUp?.();
  }
}
