import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_CHECK_INTERVAL, buildConfig } from '../src/config.js';
import { ConfigError } from '../src/utils/errors.js';
import { backoffDelay, isRetryableStatus, parseRetryAfter, withRetry } from '../src/utils/http.js';
import { HttpError } from '../src/utils/errors.js';
import { formatNumber, normalizeUsername, safeUrl, toIsoTimestamp, truncate } from '../src/utils/format.js';

const VALID_LIVE = 'https://discord.com/api/webhooks/111111111111111111/live-token';
const VALID_CONTENT = 'https://discord.com/api/webhooks/222222222222222222/content-token';

describe('buildConfig', () => {
  it('menerima konfigurasi minimal yang valid', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE,
      DISCORD_CONTENT_WEBHOOK_URL: VALID_CONTENT,
    });

    assert.equal(config.username, 'someone');
    assert.equal(config.checkInterval, 60_000, 'default 1 menit');
    assert.equal(config.liveEnabled, true);
    assert.equal(config.contentEnabled, true);
    assert.equal(config.contentProvider, 'web');
  });

  it('gagal dengan pesan jelas kalau TIKTOK_USERNAME kosong', () => {
    assert.throws(() => buildConfig({ DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /TIKTOK_USERNAME wajib diisi/);
      return true;
    });
  });

  it('gagal kalau kedua webhook kosong', () => {
    assert.throws(() => buildConfig({ TIKTOK_USERNAME: 'someone' }), {
      message: /Minimal salah satu dari DISCORD_LIVE_WEBHOOK_URL/,
    });
  });

  it('melaporkan SEMUA masalah sekaligus, bukan satu per satu', () => {
    try {
      buildConfig({ CHECK_INTERVAL: 'abc' });
      assert.fail('seharusnya melempar error');
    } catch (error) {
      assert.match(error.message, /TIKTOK_USERNAME/);
      assert.match(error.message, /CHECK_INTERVAL/);
      assert.match(error.message, /DISCORD_LIVE_WEBHOOK_URL/);
    }
  });

  it('satu webhook saja tetap boleh; fitur lainnya dimatikan dengan peringatan', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE,
    });

    assert.equal(config.liveEnabled, true);
    assert.equal(config.contentEnabled, false);
    assert.ok(config.warnings.some((w) => w.includes('DISCORD_CONTENT_WEBHOOK_URL')));
  });

  it('menolak URL webhook yang bukan milik Discord', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_LIVE_WEBHOOK_URL: 'https://evil.example.com/api/webhooks/1/token',
        }),
      { message: /harus mengarah ke domain discord\.com/ },
    );
  });

  it('menolak webhook yang formatnya salah', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_LIVE_WEBHOOK_URL: 'https://discord.com/api/webhooks/bukan-angka/token',
        }),
      { message: /formatnya salah/ },
    );
  });

  it('menolak CHECK_INTERVAL di bawah batas minimum', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE,
          CHECK_INTERVAL: '1000',
        }),
      { message: new RegExp(`CHECK_INTERVAL minimal ${MIN_CHECK_INTERVAL}`) },
    );
  });

  it('provider official wajib punya kredensialnya', () => {
    assert.throws(
      () =>
        buildConfig({
          TIKTOK_USERNAME: 'someone',
          DISCORD_CONTENT_WEBHOOK_URL: VALID_CONTENT,
          TIKTOK_CONTENT_PROVIDER: 'official',
        }),
      { message: /TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN/ },
    );
  });

  it('membersihkan username yang ditulis sebagai @user atau URL lengkap', () => {
    const fromUrl = buildConfig({
      TIKTOK_USERNAME: 'https://www.tiktok.com/@someone',
      DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE,
    });
    assert.equal(fromUrl.username, 'someone');

    const fromAt = buildConfig({
      TIKTOK_USERNAME: '  @someone  ',
      DISCORD_LIVE_WEBHOOK_URL: VALID_LIVE,
    });
    assert.equal(fromAt.username, 'someone');
  });

  it('membuang query string dari URL webhook', () => {
    const config = buildConfig({
      TIKTOK_USERNAME: 'someone',
      DISCORD_LIVE_WEBHOOK_URL: `${VALID_LIVE}?wait=true`,
    });
    assert.equal(config.discord.liveWebhookUrl, VALID_LIVE);
  });
});

describe('format helpers', () => {
  it('formatNumber memberi pemisah ribuan, null untuk nilai tak tersedia', () => {
    assert.equal(formatNumber(1234), '1,234');
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(null), null);
    assert.equal(formatNumber(undefined), null);
    assert.equal(formatNumber(Number.NaN), null);
    assert.equal(formatNumber(-5), null);
  });

  it('truncate menambahkan elipsis tanpa melewati batas', () => {
    assert.equal(truncate('halo', 10), 'halo');
    assert.equal(truncate('x'.repeat(20), 5).length, 5);
    assert.equal(truncate(null, 5), '');
  });

  it('toIsoTimestamp menerima epoch detik, ms, dan string ISO', () => {
    assert.equal(toIsoTimestamp(1789602913), new Date(1789602913 * 1000).toISOString());
    assert.equal(toIsoTimestamp(1789602913000), new Date(1789602913000).toISOString());
    assert.equal(toIsoTimestamp('2026-09-25T10:00:00.000Z'), '2026-09-25T10:00:00.000Z');
    assert.equal(toIsoTimestamp('bukan tanggal'), null);
    assert.equal(toIsoTimestamp(null), null);
  });

  it('safeUrl hanya meloloskan http/https', () => {
    assert.equal(safeUrl('https://a.test/b'), 'https://a.test/b');
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('bukan url'), null);
    assert.equal(safeUrl(null), null);
  });

  it('normalizeUsername membuang @, spasi, dan sisa path', () => {
    assert.equal(normalizeUsername('@someone'), 'someone');
    assert.equal(normalizeUsername('https://www.tiktok.com/@someone/live'), 'someone');
    assert.equal(normalizeUsername('  someone  '), 'someone');
    assert.equal(normalizeUsername(undefined), '');
  });
});

describe('http retry', () => {
  it('menandai status mana yang layak dicoba ulang', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(401), false);
  });

  it('parseRetryAfter membaca detik maupun HTTP-date', () => {
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': '2' })), 2000);
    assert.equal(parseRetryAfter(new Headers({ 'x-ratelimit-reset-after': '0.5' })), 500);
    assert.equal(parseRetryAfter(new Headers({})), undefined);

    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(new Headers({ 'retry-after': future }));
    assert.ok(parsed > 3000 && parsed <= 6000);
  });

  it('backoffDelay naik secara eksponensial dan dibatasi maksimum', () => {
    const rng = () => 1; // jitter maksimum, hasilnya deterministik
    assert.equal(backoffDelay(0, 1000, 30_000, rng), 1000);
    assert.equal(backoffDelay(1, 1000, 30_000, rng), 2000);
    assert.equal(backoffDelay(2, 1000, 30_000, rng), 4000);
    assert.equal(backoffDelay(10, 1000, 30_000, rng), 30_000, 'dibatasi maxMs');
  });

  it('withRetry mengulang error retryable lalu berhasil', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError('boom', { retryable: true });
        return 'ok';
      },
      { retries: 3, sleepFn: async () => {} },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('withRetry TIDAK mengulang error permanen', async () => {
    let calls = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError('404', { retryable: false });
        },
        { retries: 5, sleepFn: async () => {} },
      ),
    );
    assert.equal(calls, 1);
  });

  it('withRetry menyerah setelah percobaan habis dan melempar error terakhir', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new HttpError('selalu gagal', { retryable: true });
          },
          { retries: 2, sleepFn: async () => {} },
        ),
      { message: 'selalu gagal' },
    );
    assert.equal(calls, 3, '1 percobaan awal + 2 pengulangan');
  });
});
