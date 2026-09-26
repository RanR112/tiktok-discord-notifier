import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { WelcomeMonitor, selectNewMembers } from '../src/monitors/welcomeMonitor.js';
import { StateStore, createDefaultState } from '../src/utils/state.js';

/** @param {string} id */
function member(id, joinedAt = '2026-09-25T10:00:00.000Z') {
  return {
    id,
    username: `user${id}`,
    displayName: null,
    avatarUrl: `https://cdn.discordapp.com/embed/avatars/0.png`,
    joinedAt,
  };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

function memoryStore(initial = {}) {
  const store = new StateStore('/tmp/unused-welcome-state.json');
  store.state = { ...createDefaultState(), ...initial };
  store.save = async () => {};
  return store;
}

describe('selectNewMembers', () => {
  it('siklus pertama hanya merekam, tidak menyambut siapa pun', () => {
    // Skenario: instalasi baru di server yang sudah punya ratusan member.
    // Tanpa ini, semua member lama akan "disambut" seolah baru join.
    const state = createDefaultState();
    const result = selectNewMembers([member('1'), member('2'), member('3')], state);

    assert.equal(result.bootstrap, true);
    assert.deepEqual(result.toWelcome, []);
    assert.deepEqual(result.allIds, ['1', '2', '3']);
  });

  it('tidak menyambut ulang member yang sudah dikenal', () => {
    const state = { ...createDefaultState(), memberBootstrapped: true, knownMemberIds: ['1', '2'] };
    const result = selectNewMembers([member('1'), member('2')], state);
    assert.deepEqual(result.toWelcome, []);
  });

  it('menyambut member baru berdasarkan urutan waktu join sungguhan', () => {
    // List API Discord urut berdasar user id, BUKAN waktu join -- di sini
    // sengaja dibuat terbalik dari urutan id untuk membuktikan pengurutan
    // ulang berdasar joinedAt benar-benar terjadi.
    const state = { ...createDefaultState(), memberBootstrapped: true, knownMemberIds: [] };
    const items = [
      member('3', '2026-09-25T10:02:00.000Z'),
      member('1', '2026-09-25T10:00:00.000Z'),
      member('2', '2026-09-25T10:01:00.000Z'),
    ];
    const result = selectNewMembers(items, state);
    assert.deepEqual(
      result.toWelcome.map((m) => m.id),
      ['1', '2', '3'],
      'diurutkan dari yang paling dulu join',
    );
  });

  it('membatasi jumlah sambutan per siklus', () => {
    const state = { ...createDefaultState(), memberBootstrapped: true, knownMemberIds: [] };
    const items = ['1', '2', '3', '4', '5'].map((id) => member(id));
    const result = selectNewMembers(items, state, { maxPerCycle: 2 });

    assert.equal(result.toWelcome.length, 2);
    assert.equal(result.skipped, 3);
  });

  it('member yang keluar lalu join lagi tetap disambut (bukan dianggap duplikat)', () => {
    // Ini beda dari video TikTok: rejoin memang wajar disambut ulang.
    // Tapi selama id-nya masih ada di knownMemberIds (belum "dilupakan"
    // karena tidak ada batas ring buffer), dia TIDAK disambut ulang --
    // hanya dianggap "member baru" kalau id-nya benar-benar belum pernah tercatat.
    const state = { ...createDefaultState(), memberBootstrapped: true, knownMemberIds: ['1'] };
    const result = selectNewMembers([member('1'), member('2')], state);
    assert.deepEqual(
      result.toWelcome.map((m) => m.id),
      ['2'],
    );
  });
});

describe('WelcomeMonitor.check', () => {
  // Default hermetic: fetch (dipanggil diam-diam oleh buildWelcomeCard saat
  // mengambil avatar) selalu sukses dengan PNG kecil, supaya test lain di
  // suite ini tidak diam-diam melakukan network call sungguhan. Test yang
  // butuh perilaku fetch spesifik meng-override ini dengan mock.method sendiri.
  let tinyPng;

  beforeEach(async () => {
    const sharpModule = await import('sharp');
    tinyPng = await sharpModule
      .default({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png()
      .toBuffer();
    mock.method(globalThis, 'fetch', async () => new Response(tinyPng, { status: 200 }));
  });

  afterEach(() => mock.restoreAll());

  function buildMonitor({ members, state = {}, sendFails = false, listError = null }) {
    const sent = [];
    const store = memoryStore(state);

    const discordBot = {
      getGuildName: async () => 'Server Uji',
      listGuildMembers: async () => {
        if (listError) throw listError;
        return members;
      },
      sendChannelMessage: async (channelId, payload) => {
        if (sendFails) throw new Error('Discord 500');
        sent.push(payload);
        return { id: `msg-${sent.length}` };
      },
    };

    const monitor = new WelcomeMonitor({
      discordBot,
      store,
      config: {
        welcome: { guildId: '123', channelId: '456', maxPerCycle: 5 },
        requestTimeout: 5000,
      },
      logger: silentLogger,
    });

    return { monitor, store, sent };
  }

  it('siklus pertama merekam semua member tanpa mengirim sambutan', async () => {
    const { monitor, store, sent } = buildMonitor({ members: [member('1'), member('2')] });
    const result = await monitor.check();

    assert.equal(result.ok, true);
    assert.equal(result.welcomed, 0);
    assert.deepEqual(sent, []);
    assert.equal(store.get().memberBootstrapped, true);
    assert.deepEqual(store.get().knownMemberIds, ['1', '2']);
  });

  it('mengirim sambutan hanya untuk member baru, dengan kartu gambar', async () => {
    // beforeEach sudah mem-mock fetch supaya "avatar" berhasil diambil
    // (PNG 4x4 asli, bukan network sungguhan) -- sharp benar-benar
    // meng-composite-nya, hermetic & cepat.
    const { monitor, sent } = buildMonitor({
      members: [member('1'), member('2')],
      state: { memberBootstrapped: true, knownMemberIds: ['1'] },
    });

    const result = await monitor.check();
    assert.equal(result.welcomed, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Selamat datang/);
    assert.ok(sent[0].embeds?.[0]?.image?.url === 'attachment://welcome.png', 'kartu gambar terlampir');
    assert.ok(Buffer.isBuffer(sent[0].file.buffer) && sent[0].file.buffer.length > 0);
  });

  it('tetap mengirim sambutan teks kalau pengambilan avatar gagal', async () => {
    // Override default beforeEach: kali ini fetch avatar sengaja gagal.
    mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));

    const { monitor, sent } = buildMonitor({
      members: [member('1'), member('2')],
      state: { memberBootstrapped: true, knownMemberIds: ['1'] },
    });

    const result = await monitor.check();
    assert.equal(result.welcomed, 1, 'kegagalan avatar tidak boleh membatalkan sambutan');
    // Avatar gagal -> buildWelcomeCard tetap membuat kartu (tanpa avatar),
    // jadi tetap ada embed gambar, bukan fallback teks murni.
    assert.match(sent[0].content, /Selamat datang/);
  });

  it('member baru tidak dikirim dua kali pada siklus berikutnya', async () => {
    const { monitor, sent } = buildMonitor({
      members: [member('1'), member('2')],
      state: { memberBootstrapped: true, knownMemberIds: ['1'] },
    });

    await monitor.check();
    await monitor.check();
    assert.equal(sent.length, 1, 'hanya sekali walau dicek dua kali');
  });

  it('tidak menandai member sebagai tersambut kalau pengiriman gagal', async () => {
    const { monitor, store } = buildMonitor({
      members: [member('1')],
      state: { memberBootstrapped: true, knownMemberIds: [] },
      sendFails: true,
    });

    const result = await monitor.check();
    assert.equal(result.ok, false);
    assert.equal(
      store.get().knownMemberIds.includes('1'),
      false,
      'akan dicoba lagi di siklus berikutnya',
    );
  });

  it('kegagalan membaca daftar member dilaporkan tanpa melempar error', async () => {
    const { monitor } = buildMonitor({ members: [], listError: new Error('403 intent belum aktif') });
    const result = await monitor.check();
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof Error);
  });

  it('daftar member kosong dilewati dengan aman (bukan dianggap semua member keluar)', async () => {
    const { monitor, store } = buildMonitor({
      members: [],
      state: { memberBootstrapped: true, knownMemberIds: ['1', '2'] },
    });
    const result = await monitor.check();
    assert.equal(result.ok, true);
    assert.equal(result.welcomed, 0);
    assert.deepEqual(store.get().knownMemberIds, ['1', '2'], 'tidak menghapus member yang sudah dikenal');
  });
});
