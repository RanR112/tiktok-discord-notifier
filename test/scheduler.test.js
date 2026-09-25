import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Scheduler } from '../src/scheduler.js';
import { StateStore, createDefaultState } from '../src/utils/state.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function memoryStore() {
  const store = new StateStore('/tmp/unused.json');
  store.state = createDefaultState();
  store.save = async () => {};
  return store;
}

describe('Scheduler', () => {
  it('menjalankan semua monitor dalam satu siklus', async () => {
    const ran = [];
    const scheduler = new Scheduler({
      monitors: [
        { name: 'live', check: async () => { ran.push('live'); return { ok: true }; } },
        { name: 'content', check: async () => { ran.push('content'); return { ok: true }; } },
      ],
      store: memoryStore(),
      intervalMs: 1000,
      logger: silentLogger,
    });

    await scheduler.runOnce();
    assert.deepEqual(ran.sort(), ['content', 'live']);
  });

  it('monitor yang melempar error tidak menghentikan monitor lain', async () => {
    // Inti persyaratan: kegagalan LIVE tidak boleh mematikan content, dan sebaliknya.
    let contentRan = false;
    const scheduler = new Scheduler({
      monitors: [
        { name: 'live', check: async () => { throw new Error('TikTok down'); } },
        { name: 'content', check: async () => { contentRan = true; return { ok: true }; } },
      ],
      store: memoryStore(),
      intervalMs: 1000,
      logger: silentLogger,
    });

    await assert.doesNotReject(() => scheduler.runOnce());
    assert.equal(contentRan, true);
  });

  it('mencatat waktu pengecekan terakhir ke state', async () => {
    const store = memoryStore();
    const scheduler = new Scheduler({
      monitors: [{ name: 'noop', check: async () => ({ ok: true }) }],
      store,
      intervalMs: 1000,
      logger: silentLogger,
    });

    await scheduler.runOnce();
    assert.ok(store.get().lastCheckedAt, 'lastCheckedAt terisi');
    assert.doesNotThrow(() => new Date(store.get().lastCheckedAt).toISOString());
  });

  it('stop() membangunkan loop dari jeda dan menghentikannya tanpa menunggu interval penuh', async () => {
    // Ini jalur yang dipakai handler SIGINT/SIGTERM. Intervalnya sengaja sangat
    // besar: kalau stop() tidak membatalkan jeda, test ini akan timeout.
    let cycles = 0;
    const scheduler = new Scheduler({
      monitors: [{ name: 'noop', check: async () => { cycles += 1; return { ok: true }; } }],
      store: memoryStore(),
      intervalMs: 60 * 60 * 1000,
      logger: silentLogger,
    });

    const startedAt = Date.now();
    const loop = scheduler.start();

    // Beri kesempatan siklus pertama selesai, lalu hentikan.
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();
    await loop;

    assert.equal(cycles, 1, 'tepat satu siklus dijalankan');
    assert.ok(Date.now() - startedAt < 5000, 'berhenti segera, bukan setelah 1 jam');
    assert.equal(scheduler.running, false);
  });

  it('start() dua kali tidak menjalankan dua loop sekaligus', async () => {
    const scheduler = new Scheduler({
      monitors: [{ name: 'noop', check: async () => ({ ok: true }) }],
      store: memoryStore(),
      intervalMs: 60 * 60 * 1000,
      logger: silentLogger,
    });

    const first = scheduler.start();
    const second = scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();
    await Promise.all([first, second]);

    assert.equal(scheduler.cycle, 1);
  });
});
