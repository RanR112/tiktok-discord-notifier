import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  COLOR_CONTENT,
  COLOR_LIVE,
  COLOR_LIVE_ENDED,
  DiscordService,
  buildContentEmbed,
  buildLiveEmbed,
} from '../src/services/discord.js';
import { redactSecrets } from '../src/utils/logger.js';

const LIVE_HOOK = 'https://discord.com/api/webhooks/111111111111111111/live-token';
const CONTENT_HOOK = 'https://discord.com/api/webhooks/222222222222222222/content-token';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('buildLiveEmbed', () => {
  const data = {
    username: 'someone',
    displayName: 'Some One',
    isLive: true,
    liveId: 'room-A',
    title: 'Judul Live',
    viewers: 1234,
    url: 'https://www.tiktok.com/@someone/live',
    thumbnail: 'https://p16-webcast.tiktokcdn.com/cover.jpg',
    startedAt: '2026-09-25T10:00:00.000Z',
    avatar: 'https://p16.tiktokcdn.com/avatar.jpg',
  };

  it('memakai warna LIVE dan memuat judul, penonton, serta link', () => {
    const embed = buildLiveEmbed(data);
    assert.equal(embed.color, COLOR_LIVE);
    assert.match(embed.description, /@someone.*sedang LIVE/s);

    const fieldNames = embed.fields.map((f) => f.name);
    assert.ok(fieldNames.some((n) => n === 'Title'));
    assert.ok(fieldNames.some((n) => n.includes('Viewers')));

    const viewers = embed.fields.find((f) => f.name.includes('Viewers'));
    assert.equal(viewers.value, '1,234', 'angka diformat dengan pemisah ribuan');

    const link = embed.fields.find((f) => f.name.includes('Link'));
    assert.equal(link.value, `[Watch LIVE](${data.url})`);
    assert.equal(embed.image.url, data.thumbnail);
  });

  it('memakai warna abu-abu saat sesi sudah berakhir', () => {
    const embed = buildLiveEmbed(data, { ended: true });
    assert.equal(embed.color, COLOR_LIVE_ENDED);
    assert.match(embed.description, /selesai LIVE/);
  });

  it('menghilangkan field yang datanya tidak tersedia, bukan menulis nol palsu', () => {
    const embed = buildLiveEmbed({ ...data, title: null, viewers: null, thumbnail: null });
    const names = embed.fields.map((f) => f.name);
    assert.equal(names.some((n) => n.includes('Viewers')), false);
    assert.equal(names.includes('Title'), false);
    assert.equal('image' in embed, false);
  });

  it('menolak URL thumbnail yang tidak valid agar Discord tidak menolak payload', () => {
    const embed = buildLiveEmbed({ ...data, thumbnail: 'javascript:alert(1)' });
    assert.equal('image' in embed, false);
  });

  it('tidak pernah memuat nilai null (Discord menolak payload seperti itu)', () => {
    const embed = buildLiveEmbed({ ...data, title: null, viewers: null, avatar: null });
    assert.equal(JSON.stringify(embed).includes('null'), false);
  });
});

describe('buildContentEmbed', () => {
  const data = {
    id: '123',
    username: 'someone',
    displayName: 'Some One',
    caption: 'Caption video...',
    url: 'https://www.tiktok.com/@someone/video/123',
    thumbnail: 'https://p16.tiktokcdn.com/cover.jpg',
    publishedAt: '2026-09-25T09:00:00.000Z',
    views: 12345,
    likes: 1234,
    comments: 123,
    shares: 123,
    source: 'web',
  };

  it('memakai warna konten dan menampilkan keempat statistik', () => {
    const embed = buildContentEmbed(data);
    assert.equal(embed.color, COLOR_CONTENT);
    assert.notEqual(embed.color, COLOR_LIVE, 'warna LIVE dan konten harus berbeda');

    const values = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Views') && v === '12,345'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Likes') && v === '1,234'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Comments') && v === '123'));
    assert.ok(Object.entries(values).some(([k, v]) => k.includes('Shares') && v === '123'));
  });

  it('tetap membentuk embed yang valid saat statistik tidak tersedia', () => {
    const embed = buildContentEmbed({
      ...data,
      views: null,
      likes: null,
      comments: null,
      shares: null,
    });
    const link = embed.fields.find((f) => f.name.includes('Link'));
    assert.ok(link, 'link ke video tetap ada');
    assert.match(embed.footer.text, /statistik tidak tersedia/);
  });

  it('memotong caption yang sangat panjang', () => {
    const embed = buildContentEmbed({ ...data, caption: 'x'.repeat(5000) });
    assert.ok(embed.description.length <= 4096);
  });
});

describe('DiscordService — pemisahan webhook', () => {
  function serviceWithFetchMock(response) {
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url: String(url), init });
      return response();
    });

    const service = new DiscordService({
      liveWebhookUrl: LIVE_HOOK,
      contentWebhookUrl: CONTENT_HOOK,
      retries: 1,
      logger: silentLogger,
    });
    return { service, calls };
  }

  const okResponse = () =>
    new Response(JSON.stringify({ id: 'msg-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('notifikasi LIVE hanya pergi ke webhook LIVE', async (t) => {
    t.after(() => mock.restoreAll());
    const { service, calls } = serviceWithFetchMock(okResponse);

    await service.sendLiveNotification({
      username: 'someone',
      displayName: 'Some One',
      isLive: true,
      liveId: 'room-A',
      title: 't',
      viewers: 1,
      url: 'https://www.tiktok.com/@someone/live',
      thumbnail: null,
      startedAt: '2026-09-25T10:00:00.000Z',
      avatar: null,
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(LIVE_HOOK));
    assert.equal(calls[0].url.includes(CONTENT_HOOK), false);
    assert.ok(calls[0].url.includes('wait=true'), 'wait=true supaya id pesan bisa disimpan');
  });

  it('notifikasi konten hanya pergi ke webhook konten', async (t) => {
    t.after(() => mock.restoreAll());
    const { service, calls } = serviceWithFetchMock(okResponse);

    await service.sendContentNotification({
      id: '1',
      username: 'someone',
      displayName: 'Some One',
      caption: 'c',
      url: 'https://www.tiktok.com/@someone/video/1',
      thumbnail: null,
      publishedAt: '2026-09-25T09:00:00.000Z',
      views: null,
      likes: null,
      comments: null,
      shares: null,
      source: 'web',
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(CONTENT_HOOK));
    assert.equal(calls[0].url.includes(LIVE_HOOK), false);
  });

  it('melewati notifikasi LIVE tanpa error kalau webhook-nya tidak dikonfigurasi', async () => {
    const service = new DiscordService({
      liveWebhookUrl: null,
      contentWebhookUrl: CONTENT_HOOK,
      logger: silentLogger,
    });
    assert.equal(await service.sendLiveNotification({ username: 'x' }), null);
  });

  it('menghormati Retry-After saat kena HTTP 429 lalu mencoba lagi', async (t) => {
    t.after(() => mock.restoreAll());

    let attempt = 0;
    const calls = [];
    mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      attempt += 1;
      if (attempt === 1) {
        return new Response('{"message":"rate limited"}', {
          status: 429,
          headers: { 'retry-after': '0.01', 'content-type': 'application/json' },
        });
      }
      return okResponse();
    });

    const service = new DiscordService({
      liveWebhookUrl: LIVE_HOOK,
      contentWebhookUrl: null,
      retries: 2,
      logger: silentLogger,
    });

    const result = await service.sendLiveNotification({
      username: 'someone',
      displayName: null,
      isLive: true,
      liveId: 'a',
      title: null,
      viewers: null,
      url: 'https://www.tiktok.com/@someone/live',
      thumbnail: null,
      startedAt: null,
      avatar: null,
    });

    assert.equal(calls.length, 2, 'dicoba ulang tepat satu kali');
    assert.equal(result.id, 'msg-1');
  });

  it('tidak mencoba ulang error klien permanen seperti 404', async (t) => {
    t.after(() => mock.restoreAll());

    const calls = [];
    mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      return new Response('{"message":"Unknown Webhook"}', { status: 404 });
    });

    const service = new DiscordService({
      liveWebhookUrl: LIVE_HOOK,
      contentWebhookUrl: null,
      retries: 3,
      logger: silentLogger,
    });

    await assert.rejects(() =>
      service.sendLiveNotification({
        username: 'someone',
        displayName: null,
        isLive: true,
        liveId: 'a',
        title: null,
        viewers: null,
        url: 'https://www.tiktok.com/@someone/live',
        thumbnail: null,
        startedAt: null,
        avatar: null,
      }),
    );
    assert.equal(calls.length, 1, 'webhook salah tidak diulang 4 kali');
  });
});

describe('redactSecrets', () => {
  it('menyamarkan token webhook di dalam pesan log', () => {
    const redacted = redactSecrets(`gagal kirim ke ${LIVE_HOOK}`);
    assert.equal(redacted.includes('live-token'), false);
    assert.equal(redacted.includes('111111111111111111'), false);
    assert.match(redacted, /webhooks\/111111\*\*\*\/\*\*\*/);
  });

  it('menyamarkan field objek yang namanya sensitif', () => {
    const redacted = redactSecrets({ webhookUrl: LIVE_HOOK, refresh_token: 'abc', aman: 'ok' });
    assert.equal(redacted.webhookUrl, '***redacted***');
    assert.equal(redacted.refresh_token, '***redacted***');
    assert.equal(redacted.aman, 'ok');
  });
});
