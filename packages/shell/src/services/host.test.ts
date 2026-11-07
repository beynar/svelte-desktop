import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { services, stopAllServices } from './host.ts';
import { createDesktopRuntime } from '../desktop-api.ts';

const dir = mkdtempSync(join(tmpdir(), 'sd-services-'));
const before = process.env.KITOP_SERVICES_DIR;
process.env.KITOP_SERVICES_DIR = dir;
writeFileSync(join(dir, 'counter.ts'), `
export default (args, port) => {
  let count = args.initial ?? 0;
  port.on('message', async data => { if (data === 'slow') await Bun.sleep(150); else await port.postMessage({ echo: data }); });
  port.onRequest(async data => {
    if (data === 'exit') process.exit(7);
    if (data === 'hang') await new Promise(() => {});
    if (data === 'fail') throw new Error('expected failure');
    return { count: ++count, pid: process.pid };
  });
  return async () => { if (args.hangCleanup) await new Promise(() => {}); if (args.cleanup) await Bun.write(args.cleanup, 'closed'); };
};
`);
writeFileSync(join(dir, 'bad.ts'), `export default () => { throw new Error('initialization failed'); };`);
writeFileSync(join(dir, 'stuck.ts'), `export default async () => { await new Promise(() => {}); };`);
afterAll(async () => { await stopAllServices(); if (before === undefined) delete process.env.KITOP_SERVICES_DIR; else process.env.KITOP_SERVICES_DIR = before; rmSync(dir, { recursive: true, force: true }); });
const until = async (fn: () => boolean) => { for (let i = 0; i < 100; i++) { if (fn()) return; await Bun.sleep(10); } throw new Error('condition timed out'); };

test('duplex events, persistent request/reply, failure and timeout', async () => {
  const child = await services.start('counter', { initial: 40 });
  const first = await child.request<{ count: number; pid: number }>({ add: 1 });
  expect(first.count).toBe(41);
  expect(await child.request({ add: 1 })).toEqual({ count: 42, pid: first.pid });
  const message = new Promise((resolve) => child.on('message', resolve));
  await child.send('hello');
  expect(await message).toEqual({ echo: 'hello' });
  expect(await child.request('fail').catch((e: Error) => e.message)).toBe('expected failure');
  expect(await child.request('hang', { timeoutMs: 30 }).catch((e: Error) => e.message)).toContain('timed out');
  await child.stop();
});

test('exit rejects pending work, restarts with fresh state, and stops permanently', async () => {
  const child = await services.start('counter', { initial: 0 }, { restart: { maxRestarts: 1, delayMs: 10 } });
  const pid = child.pid;
  const events: unknown[] = [];
  child.on('exit', (e) => events.push(e));
  expect(await child.request('exit').catch((e: Error) => e.message)).toContain('exited with code 7');
  await until(() => child.state === 'running' && child.pid !== pid);
  expect(await child.request('count')).toMatchObject({ count: 1 });
  expect(events).toEqual([{ code: 7, signal: null, restarting: true }]);
  await child.request('exit').catch(() => {});
  await until(() => child.state === 'stopped');
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ restarting: false });
  await child.stop();
});

test('bounded queue and payload, invalid names and startup failure', async () => {
  expect(await services.start('../counter').catch((e: Error) => e.message)).toContain('invalid service name');
  expect(await services.start('bad').catch((e: Error) => e.message)).toContain('exited');
  expect(await services.start('stuck', null, { startupTimeoutMs: 30 }).catch((e: Error) => e.message)).toContain('startup timed out');
  const child = await services.start('counter', {}, { capacity: 1, maxMessageBytes: 100 });
  const slow = child.send('slow');
  expect(await child.send('overflow').catch((e: Error) => e.message)).toBe('service queue full');
  await slow;
  expect(await child.send('x'.repeat(100)).catch((e: Error) => e.message)).toContain('maxMessageBytes');
  await child.stop();
});

test('quit cleanup aborts children, rejects requests and prevents pending restarts', async () => {
  const cleanup = join(dir, 'cleanup');
  const child = await services.start('counter', { cleanup }, { restart: { maxRestarts: 5, delayMs: 100 } });
  const waiting = child.request('hang').catch((e: Error) => e.message);
  await stopAllServices();
  expect(await waiting).toContain('stopped');
  expect(child.state).toBe('stopped');
  expect(existsSync(cleanup)).toBe(true);
  await child.stop();
  const restarting = await services.start('counter', {}, { restart: { maxRestarts: 5, delayMs: 100 } });
  await restarting.request('exit').catch(() => {});
  await stopAllServices();
  await Bun.sleep(150);
  expect(restarting.state).toBe('stopped');
  expect(restarting.pid).toBeUndefined();
});


test('pending requests are bounded and uncooperative cleanup is force-killed', async () => {
  const child = await services.start('counter', { hangCleanup: true }, { capacity: 1 });
  const waiting = child.request('hang').catch((e: Error) => e.message);
  expect(await child.request('next').catch((e: Error) => e.message)).toBe('service requests full');
  const started = Date.now();
  await child.stop();
  expect(await waiting).toContain('stopped');
  expect(Date.now() - started).toBeLessThan(2000);
  expect(child.pid).toBeUndefined();
});

test('parent disappearance runs child cleanup instead of leaving an orphan', async () => {
  const cleanup = join(dir, 'disconnect-cleanup'), pidFile = join(dir, 'disconnect-pid');
  const runner = join(dir, 'parent.ts');
  writeFileSync(runner, `import { services } from ${JSON.stringify(join(import.meta.dir, 'host.ts'))};
const child = await services.start('counter', { cleanup: ${JSON.stringify(cleanup)} });
await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
process.exit(0);`);
  const parent = Bun.spawn([process.execPath, runner], { env: { ...process.env }, stdout: 'ignore', stderr: 'inherit' });
  await parent.exited;
  // Windows ends a process's children with it (Bun's job object), so nothing is left behind but nothing cleans up.
  if (process.platform !== 'win32') {
    await until(() => existsSync(cleanup));
    expect(await Bun.file(cleanup).text()).toBe('closed');
  }
  const pid = Number(await Bun.file(pidFile).text());
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});


test('an exit listener can stop supervision before its restart is queued', async () => {
  const child = await services.start('counter', {}, { restart: { maxRestarts: 3, delayMs: 10 } });
  child.on('exit', () => { void child.stop(); });
  await child.request('exit').catch(() => {});
  await Bun.sleep(50);
  expect(child.state).toBe('stopped');
  expect(child.pid).toBeUndefined();
});


test('each desktop runtime cleans up services, including a reopened dev shell', async () => {
  for (let i = 0; i < 2; i++) {
    const runtime = createDesktopRuntime({ appName: 'Service test', identifier: `sd-service-test-${crypto.randomUUID()}`, origin: 'http://localhost', quit() {} });
    try {
      const child = await services.start('counter', {});
      await runtime.runBeforeQuit();
      expect(child.state).toBe('stopped');
      expect(child.pid).toBeUndefined();
    } finally {
      rmSync(runtime.api.paths.data, { recursive: true, force: true });
      rmSync(runtime.api.paths.cache, { recursive: true, force: true });
    }
  }
});
