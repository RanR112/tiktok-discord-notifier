import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { DiscordBotService, buildAvatarUrl, mapGuildMember } from '../src/services/discordBot.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('buildAvatarUrl', () => {
  it('memakai avatar custom PNG kalau ada', () => {
    const url = buildAvatarUrl({ id: '123456789012345678', avatar: 'abc123' });
    assert.equal(url, 'https://cdn.discordapp.com/avatars/123456789012345678/abc123.png?size=256');
  });

  it('memakai ekstensi .gif untuk avatar animasi (prefix a_)', () => {
    const url = buildAvatarUrl({ id: '123456789012345678', avatar: 'a_abc123' });
    assert.match(url, /\.gif\?size=256$/);
  });

  it('jatuh ke default avatar kalau user tidak punya avatar custom', () => {
    const url = buildAvatarUrl({ id: '123456789012345678', avatar: null });
    assert.match(url, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  it('index default avatar konsisten untuk id yang sama', () => {
    const a = buildAvatarUrl({ id: '999999999999999999', avatar: null });
    const b = buildAvatarUrl({ id: '999999999999999999', avatar: null });
    assert.equal(a, b);
  });
});

describe('mapGuildMember', () => {
  it('memetakan field dari Guild Member Object', () => {
    const member = mapGuildMember({
      nick: 'Nickname',
      avatar: null,
      joined_at: '2026-09-25T10:00:00.000Z',
      user: { id: '111222333444555666', username: 'someone', avatar: 'hash123', global_name: 'Some One' },
    });

    assert.equal(member.id, '111222333444555666');
    assert.equal(member.username, 'someone');
    assert.equal(member.displayName, 'Nickname', 'nickname server diprioritaskan');
    assert.equal(member.joinedAt, '2026-09-25T10:00:00.000Z');
    assert.match(member.avatarUrl, /hash123/);
  });

  it('jatuh ke global_name lalu null kalau tidak ada nickname', () => {
    const withGlobalName = mapGuildMember({
      user: { id: '1', username: 'x', global_name: 'Global Name', avatar: null },
    });
    assert.equal(withGlobalName.displayName, 'Global Name');

    const withNeither = mapGuildMember({ user: { id: '1', username: 'x', avatar: null } });
    assert.equal(withNeither.displayName, null);
  });

  it('mengembalikan null kalau tidak ada user.id', () => {
    assert.equal(mapGuildMember({}), null);
    assert.equal(mapGuildMember(null), null);
  });

  it('bot lain TETAP dianggap member dan bisa disambut (perilaku yang disengaja)', () => {
    // Discord List Guild Members MEMANG menyertakan bot di responsnya
    // (dikonfirmasi langsung saat debugging: bot "OwO" ikut muncul).
    // Ini sengaja tidak difilter di project ini.
    const bot = mapGuildMember({
      user: { id: '1', username: 'SomeOtherBot', bot: true, avatar: null },
    });
    assert.notEqual(bot, null);
    assert.equal(bot.id, '1');
  });
});

describe('DiscordBotService', () => {
  it('listGuildMembers memberi pesan yang jelas saat 403 (intent belum aktif)', async (t) => {
    t.after(() => mock.restoreAll());
    mock.method(globalThis, 'fetch', async () =>
      new Response('{"message":"Missing Access"}', { status: 403 }),
    );

    const service = new DiscordBotService({ botToken: 'x', retries: 0, logger: silentLogger });
    await assert.rejects(() => service.listGuildMembers('123'), {
      message: /privileged intent "Server Members"/,
    });
  });

  it('listGuildMembers melakukan pagination sampai halaman tidak penuh', async (t) => {
    t.after(() => mock.restoreAll());
    const calls = [];

    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      user: { id: String(i + 1), username: `user${i}`, avatar: null },
      joined_at: '2026-09-25T10:00:00.000Z',
    }));
    const page2 = [{ user: { id: '1001', username: 'last', avatar: null }, joined_at: '2026-09-25T10:00:00.000Z' }];

    mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      const body = calls.length === 1 ? page1 : page2;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const service = new DiscordBotService({ botToken: 'x', retries: 0, logger: silentLogger });
    const members = await service.listGuildMembers('123');

    assert.equal(calls.length, 2, 'berhenti setelah halaman kedua yang tidak penuh (1000)');
    assert.equal(members.length, 1001);
    assert.ok(calls[1].includes('after=1000'), 'halaman kedua memakai id terakhir sebagai cursor');
  });

  it('sendChannelMessage mengirim multipart dengan payload_json dan files[0]', async (t) => {
    t.after(() => mock.restoreAll());
    let capturedBody;
    let capturedHeaders;

    mock.method(globalThis, 'fetch', async (url, init) => {
      capturedBody = init.body;
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
    });

    const service = new DiscordBotService({ botToken: 'secret-token', retries: 0, logger: silentLogger });
    const result = await service.sendChannelMessage('999', {
      content: 'halo',
      file: { buffer: Buffer.from('fake-png'), filename: 'welcome.png', contentType: 'image/png' },
    });

    assert.equal(result.id, 'msg-1');
    assert.ok(capturedBody instanceof FormData);
    assert.equal(capturedHeaders.authorization, 'Bot secret-token');
  });

  it('TIDAK PERNAH mengirim User-Agent palsu ala browser ke Discord', async (t) => {
    // Regresi nyata (2026-09-26): fetchWithTimeout default-nya mengirim UA
    // palsu ala Chrome (sengaja, untuk TikTok). Discord API JUSTRU MENOLAK
    // kombinasi Bot Token + UA browser dengan HTTP 403 (code 40333). Semua
    // request lewat DiscordBotService wajib pakai UA jujur format DiscordBot.
    t.after(() => mock.restoreAll());
    let capturedHeaders;
    mock.method(globalThis, 'fetch', async (url, init) => {
      capturedHeaders = init.headers;
      return new Response('[]', { status: 200 });
    });

    const service = new DiscordBotService({ botToken: 'x', retries: 0, logger: silentLogger });
    await service.listGuildMembers('123');

    assert.match(capturedHeaders['user-agent'], /^DiscordBot \(/);
    assert.doesNotMatch(capturedHeaders['user-agent'], /Chrome|Mozilla|AppleWebKit/);
  });
});
