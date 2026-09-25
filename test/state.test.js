import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  KNOWN_CONTENT_LIMIT,
  StateStore,
  createDefaultState,
  normalizeState,
  rememberContentIds,
} from '../src/utils/state.js';

describe('normalizeState', () => {
  it('mengembalikan default untuk input yang bukan objek', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      assert.deepEqual(normalizeState(bad), createDefaultState());
    }
  });

  it('membuang field asing dan memperbaiki tipe yang salah', () => {
    const result = normalizeState({
      lastContentId: 123,
      knownContentIds: ['a', 7, '', 'b'],
      lastLiveStatus: 'true',
      lastViewerCount: 'banyak',
      hackerField: 'boom',
    });

    assert.equal(result.lastContentId, null, 'id non-string ditolak');
    assert.deepEqual(result.knownContentIds, ['a', 'b'], 'entri non-string dibuang');
    assert.equal(result.lastLiveStatus, false, 'hanya boolean true yang dihitung live');
    assert.equal(result.lastViewerCount, null);
    assert.equal('hackerField' in result, false);
  });

  it('memperlakukan state lama tanpa flag bootstrap sebagai sudah ter-bootstrap', () => {
    // Ini mencegah upgrade dari versi lama membanjiri channel dengan video lama.
    const result = normalizeState({ lastContentId: '999', knownContentIds: [] });
    assert.equal(result.contentBootstrapped, true);
  });

  it('state kosong berarti belum ter-bootstrap', () => {
    assert.equal(normalizeState({}).contentBootstrapped, false);
  });

  it('memangkas knownContentIds ke batas maksimum', () => {
    const many = Array.from({ length: KNOWN_CONTENT_LIMIT + 50 }, (_, i) => `id-${i}`);
    const result = normalizeState({ knownContentIds: many });
    assert.equal(result.knownContentIds.length, KNOWN_CONTENT_LIMIT);
    // Yang dipertahankan adalah yang paling baru (akhir array).
    assert.equal(result.knownContentIds.at(-1), `id-${KNOWN_CONTENT_LIMIT + 49}`);
  });
});

describe('rememberContentIds', () => {
  it('menambahkan id baru tanpa duplikat', () => {
    assert.deepEqual(rememberContentIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  });

  it('mengabaikan nilai kosong dan non-string', () => {
    assert.deepEqual(rememberContentIds(['a'], ['', null, undefined, 5, 'd']), ['a', 'd']);
  });

  it('tidak memutasi array masukan', () => {
    const known = ['a'];
    rememberContentIds(known, ['b']);
    assert.deepEqual(known, ['a']);
  });

  it('menghormati batas ring buffer', () => {
    const many = Array.from({ length: KNOWN_CONTENT_LIMIT + 10 }, (_, i) => `id-${i}`);
    assert.equal(rememberContentIds([], many).length, KNOWN_CONTENT_LIMIT);
  });
});

describe('StateStore', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tdn-state-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('memakai state default kalau file belum ada', async () => {
    const store = new StateStore(join(dir, 'missing.json'));
    const state = await store.load();
    assert.deepEqual(state, createDefaultState());
  });

  it('bertahan dari file JSON yang korup tanpa melempar error', async () => {
    const file = join(dir, 'corrupt.json');
    await writeFile(file, '{ ini bukan json', 'utf8');

    const warnings = [];
    const store = new StateStore(file, {
      logger: { warn: (m) => warnings.push(m), debug() {}, error() {} },
    });
    const state = await store.load();

    assert.equal(state.contentBootstrapped, false);
    assert.equal(warnings.length, 1, 'kerusakan file dilaporkan sebagai WARN');
  });

  it('menyimpan dan memuat ulang state (bertahan setelah restart)', async () => {
    const file = join(dir, 'roundtrip.json');

    const first = new StateStore(file);
    await first.load();
    await first.update({
      lastContentId: '777',
      knownContentIds: ['777', '776'],
      contentBootstrapped: true,
      currentLiveId: 'room-1',
      lastLiveStatus: true,
    });

    // Simulasi restart aplikasi: instance baru, file yang sama.
    const second = new StateStore(file);
    const reloaded = await second.load();

    assert.equal(reloaded.lastContentId, '777');
    assert.deepEqual(reloaded.knownContentIds, ['777', '776']);
    assert.equal(reloaded.contentBootstrapped, true);
    assert.equal(reloaded.currentLiveId, 'room-1');
    assert.equal(reloaded.lastLiveStatus, true);
  });

  it('menulis JSON yang valid dan tidak meninggalkan file .tmp', async () => {
    const file = join(dir, 'atomic.json');
    const store = new StateStore(file);
    await store.load();
    await store.update({ lastContentId: 'abc' });

    const raw = await readFile(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));

    await assert.rejects(() => readFile(`${file}.tmp`, 'utf8'), { code: 'ENOENT' });
  });
});
