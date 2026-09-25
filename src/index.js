#!/usr/bin/env node
/**
 * Titik masuk aplikasi.
 *
 * Flag CLI:
 *   --once        Jalankan satu siklus lalu keluar (berguna untuk debugging/cron).
 *   --check-env   Hanya validasi konfigurasi lalu keluar. Tidak menyentuh jaringan.
 */

import { buildConfig, loadEnvFile } from './config.js';
import { DiscordService } from './services/discord.js';
import { TikTokService } from './services/tiktok.js';
import { LiveMonitor } from './monitors/liveMonitor.js';
import { ContentMonitor } from './monitors/contentMonitor.js';
import { Scheduler } from './scheduler.js';
import { StateStore } from './utils/state.js';
import { ConfigError } from './utils/errors.js';
import { createLogger, setLogLevel } from './utils/logger.js';

const logger = createLogger('app');

async function main() {
  const args = new Set(process.argv.slice(2));
  const runOnce = args.has('--once');
  const checkEnvOnly = args.has('--check-env');

  // --- 1. Konfigurasi --------------------------------------------------------
  const envLoaded = loadEnvFile();
  const config = buildConfig();
  setLogLevel(config.logLevel);

  logger.info('=================================================');
  logger.info(' tiktok-discord-notifier');
  logger.info('=================================================');
  logger.info(envLoaded ? 'File .env dimuat.' : 'Tidak ada file .env; memakai environment proses.');
  logger.info(`Akun dipantau      : @${config.username}`);
  logger.info(`Interval pengecekan: ${config.checkInterval}ms`);
  logger.info(`Monitor LIVE       : ${config.liveEnabled ? 'aktif' : 'NONAKTIF'}`);
  logger.info(
    `Monitor konten     : ${config.contentEnabled ? `aktif (provider: ${config.contentProvider})` : 'NONAKTIF'}`,
  );
  logger.info(`File state         : ${config.stateFile}`);

  for (const warning of config.warnings) logger.warn(warning);

  if (!config.liveEnabled && !config.contentEnabled) {
    logger.error('Tidak ada monitor yang aktif. Isi minimal satu webhook di .env.');
    process.exitCode = 1;
    return;
  }

  if (checkEnvOnly) {
    logger.info('Konfigurasi valid. (--check-env, keluar tanpa menjalankan monitor.)');
    return;
  }

  // --- 2. State --------------------------------------------------------------
  const store = new StateStore(config.stateFile, { logger: createLogger('state') });
  await store.load();

  // --- 3. Services -----------------------------------------------------------
  const discord = new DiscordService({
    liveWebhookUrl: config.discord.liveWebhookUrl,
    contentWebhookUrl: config.discord.contentWebhookUrl,
    timeoutMs: config.requestTimeout,
    retries: config.maxRetries,
    logger: createLogger('discord'),
  });

  const tiktok = new TikTokService({ config, logger: createLogger('tiktok') });

  if (config.contentEnabled && tiktok.contentIsBestEffort) {
    logger.warn(
      `Provider konten "${tiktok.contentProviderName}" bersifat BEST-EFFORT: TikTok tidak menyediakan ` +
        'API resmi untuk membaca feed akun orang lain, dan WAF anti-bot mereka sering memblokir ' +
        'pembacaan halaman profil. Notifikasi LIVE tidak terpengaruh. Lihat README bagian Keterbatasan.',
    );
  }

  // --- 4. Monitors -----------------------------------------------------------
  const monitors = [];
  if (config.liveEnabled) {
    monitors.push(new LiveMonitor({ tiktok, discord, store, config, logger: createLogger('live') }));
  }
  if (config.contentEnabled) {
    monitors.push(
      new ContentMonitor({ tiktok, discord, store, config, logger: createLogger('content') }),
    );
  }

  // --- 5. Jalankan -----------------------------------------------------------
  const scheduler = new Scheduler({
    monitors,
    store,
    intervalMs: config.checkInterval,
    logger: createLogger('scheduler'),
  });

  if (runOnce) {
    logger.info('Mode --once: menjalankan satu siklus lalu keluar.');
    await scheduler.runOnce();
    return;
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Menerima ${signal}. Menghentikan monitoring dengan rapi...`);
    scheduler.stop();
    // Jaring pengaman kalau siklus yang berjalan menggantung.
    const force = setTimeout(() => {
      logger.warn('Shutdown melewati batas waktu. Keluar paksa.');
      process.exit(0);
    }, 10_000);
    force.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await scheduler.start();
  logger.info('Selesai.');
}

// Aplikasi tidak boleh mati karena satu promise yang lolos dari penanganan.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error?.message}`);
  logger.error('Ini bug. Proses akan keluar supaya supervisor (PM2/Docker) bisa me-restart.');
  process.exit(1);
});

main().catch((error) => {
  if (error instanceof ConfigError) {
    // Kesalahan konfigurasi: tampilkan apa adanya tanpa stack trace yang bikin bingung.
    console.error(`\n[ERROR] ${error.message}\n`);
    process.exit(1);
  }
  logger.error(`Gagal memulai aplikasi: ${error?.message}`);
  console.error(error);
  process.exit(1);
});
