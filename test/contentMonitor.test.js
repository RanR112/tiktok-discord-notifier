import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ContentMonitor, selectNewContent } from '../src/monitors/contentMonitor.js';
import { parseProfileHtml } from '../src/services/tiktok/content/webProvider.js';
import { ProviderUnavailableError } from '../src/utils/errors.js';
import { StateStore, createDefaultState } from '../src/utils/state.js';

/** @param {string} id */
function item(id, createdAt = '2026-09-25T00:00:00.000Z') {
  return {
    id,
    username: 'someone',
    displayName: 'Some One',
    caption: `caption ${id}`,
    url: `https://www.tiktok.com/@someone/video/${id}`,
    thumbnail: null,
    publishedAt: createdAt,
    views: 1,
    likes: 1,
    comments: 1,
    shares: 1,
    source: 'test',
  };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

/** StateStore in-memory: tidak menyentuh disk. */
function memoryStore(initial = {}) {
  const store = new StateStore('/tmp/unused-state.json');
  store.state = { ...createDefaultState(), ...initial };
  store.save = async () => {};
  return store;
}

describe('selectNewContent', () => {
  it('siklus pertama hanya merekam, tidak mengirim apa pun', () => {
    // Skenario: instalasi baru / file state terhapus. Tanpa ini, semua video
    // lama akan dikirim sebagai "video baru".
    const state = createDefaultState();
    const result = selectNewContent([item('3'), item('2'), item('1')], state);

    assert.equal(result.bootstrap, true);
    assert.deepEqual(result.toNotify, []);
    assert.deepEqual(result.allIds, ['3', '2', '1']);
  });

  it('tidak mengirim ulang video yang sudah diketahui', () => {
    const state = {
      ...createDefaultState(),
      contentBootstrapped: true,
      knownContentIds: ['1', '2', '3'],
    };
    const result = selectNewContent([item('3'), item('2'), item('1')], state);
    assert.deepEqual(result.toNotify, []);
  });

  it('mendeteksi video baru dan mengirimnya secara kronologis', () => {
    const state = {
      ...createDefaultState(),
      contentBootstrapped: true,
      knownContentIds: ['1', '2'],
    };
    // Provider mengembalikan terbaru-dulu: 4, 3, 2, 1
    const result = selectNewContent([item('4'), item('3'), item('2'), item('1')], state);

    assert.deepEqual(
      result.toNotify.map((i) => i.id),
      ['3', '4'],
      'yang lebih lama dikirim lebih dulu',
    );
  });

  it('membatasi jumlah notifikasi per siklus agar tidak membanjiri channel', () => {
    const state = { ...createDefaultState(), contentBootstrapped: true, knownContentIds: [] };
    const items = ['9', '8', '7', '6', '5'].map((id) => item(id));
    const result = selectNewContent(items, state, { maxPerCycle: 2 });

    assert.equal(result.toNotify.length, 2);
    assert.deepEqual(result.toNotify.map((i) => i.id), ['8', '9'], 'ambil yang paling baru');
    assert.equal(result.skipped, 3);
  });

  it('video yang di-pin naik ke atas tidak terdeteksi sebagai video baru', () => {
    // Inilah alasan dedup memakai daftar id, bukan hanya lastContentId.
    const state = {
      ...createDefaultState(),
      contentBootstrapped: true,
      lastContentId: '5',
      knownContentIds: ['1', '2', '3', '4', '5'],
    };
    // Video lama '1' sekarang muncul di posisi teratas karena di-pin.
    const result = selectNewContent([item('1'), item('5'), item('4')], state);
    assert.deepEqual(result.toNotify, []);
  });
});

describe('ContentMonitor.check', () => {
  function buildMonitor({ items, state = {}, discordFails = false, providerError = null }) {
    const sent = [];
    const store = memoryStore(state);

    const tiktok = {
      contentProviderName: 'test',
      contentIsBestEffort: false,
      getLatestContent: async () => {
        if (providerError) throw providerError;
        return items;
      },
      enrichContent: async (i) => i,
    };

    const discord = {
      sendContentNotification: async (data) => {
        if (discordFails) throw new Error('Discord 500');
        sent.push(data.id);
        return { id: `msg-${data.id}` };
      },
    };

    const monitor = new ContentMonitor({
      tiktok,
      discord,
      store,
      config: { username: 'someone', maxContentPerCycle: 3 },
      logger: silentLogger,
    });

    return { monitor, store, sent };
  }

  it('siklus pertama merekam semua video tanpa mengirim notifikasi', async () => {
    const { monitor, store, sent } = buildMonitor({ items: [item('2'), item('1')] });
    const result = await monitor.check();

    assert.equal(result.ok, true);
    assert.equal(result.notified, 0);
    assert.deepEqual(sent, []);
    assert.equal(store.get().contentBootstrapped, true);
    assert.deepEqual(store.get().knownContentIds, ['2', '1']);
  });

  it('mengirim notifikasi hanya untuk video baru', async () => {
    const { monitor, sent } = buildMonitor({
      items: [item('3'), item('2'), item('1')],
      state: { contentBootstrapped: true, knownContentIds: ['1', '2'] },
    });

    const result = await monitor.check();
    assert.equal(result.notified, 1);
    assert.deepEqual(sent, ['3']);
  });

  it('video yang sama tidak dikirim dua kali pada siklus berikutnya', async () => {
    const { monitor, sent } = buildMonitor({
      items: [item('3'), item('2'), item('1')],
      state: { contentBootstrapped: true, knownContentIds: ['1', '2'] },
    });

    await monitor.check();
    await monitor.check();
    assert.deepEqual(sent, ['3'], 'hanya sekali walau dicek dua kali');
  });

  it('tidak menandai video sebagai terkirim kalau Discord gagal', async () => {
    const { monitor, store } = buildMonitor({
      items: [item('3')],
      state: { contentBootstrapped: true, knownContentIds: ['1'] },
      discordFails: true,
    });

    const result = await monitor.check();
    assert.equal(result.notified, 0);
    assert.equal(
      store.get().knownContentIds.includes('3'),
      false,
      'video akan dicoba lagi di siklus berikutnya',
    );
  });

  it('kegagalan provider dilaporkan tanpa melempar error', async () => {
    const { monitor } = buildMonitor({
      items: [],
      providerError: new ProviderUnavailableError('diblokir WAF', { reason: 'challenge' }),
    });

    const result = await monitor.check();
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ProviderUnavailableError);
  });
});

describe('parseProfileHtml', () => {
  it('mengenali halaman tantangan anti-bot dan tidak mengarang data', () => {
    const waf =
      '<!DOCTYPE html><html><head><script id="slardar-config">{}</script></head>' +
      '<body>Please wait...<p id="wci" class="_wafchallengeid"></p></body></html>';

    assert.throws(() => parseProfileHtml(waf, 'someone'), (error) => {
      assert.ok(error instanceof ProviderUnavailableError);
      assert.equal(error.reason, 'challenge');
      return true;
    });
  });

  it('memetakan item dari __UNIVERSAL_DATA_FOR_REHYDRATION__', () => {
    const data = {
      __DEFAULT_SCOPE__: {
        'webapp.user-detail': { userInfo: { user: { nickname: 'Some One' } } },
        'webapp.user-post': {
          itemList: [
            {
              id: '123',
              desc: 'halo dunia',
              createTime: 1789602913,
              author: { uniqueId: 'someone', nickname: 'Some One' },
              video: { cover: 'https://p16.tiktokcdn.com/cover.jpg' },
              stats: { playCount: 100, diggCount: 10, commentCount: 5, shareCount: 2 },
            },
          ],
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`;

    const { items, displayName } = parseProfileHtml(html, 'someone');
    assert.equal(displayName, 'Some One');
    assert.equal(items.length, 1);
    assert.deepEqual(
      { ...items[0] },
      {
        id: '123',
        username: 'someone',
        displayName: 'Some One',
        caption: 'halo dunia',
        url: 'https://www.tiktok.com/@someone/video/123',
        thumbnail: 'https://p16.tiktokcdn.com/cover.jpg',
        publishedAt: new Date(1789602913 * 1000).toISOString(),
        views: 100,
        likes: 10,
        comments: 5,
        shares: 2,
        source: 'web',
      },
    );
  });

  it('melaporkan dengan jelas kalau daftar video tidak tertanam di HTML', () => {
    const html =
      '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
      '{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"nickname":"X"}}}}}</script>';

    assert.throws(() => parseProfileHtml(html, 'someone'), (error) => {
      assert.equal(error.reason, 'no-item-list');
      return true;
    });
  });

  it('mendukung format lama SIGI_STATE sebagai cadangan', () => {
    const data = {
      ItemModule: {
        555: {
          id: '555',
          desc: 'lama',
          createTime: 1700000000,
          author: { uniqueId: 'someone' },
          stats: { playCount: 1 },
        },
      },
      UserModule: { users: { someone: { nickname: 'Some One' } } },
    };
    const html = `<script id="SIGI_STATE" type="application/json">${JSON.stringify(data)}</script>`;

    const { items } = parseProfileHtml(html, 'someone');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '555');
  });

  it('melempar error yang jelas kalau struktur halaman sama sekali tidak dikenali', () => {
    assert.throws(() => parseProfileHtml('<html><body>hai</body></html>', 'someone'), {
      name: 'ProviderUnavailableError',
    });
  });
});
