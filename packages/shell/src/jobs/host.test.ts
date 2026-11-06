import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { jobs, stopAllJobs } from './host.ts';
const dir = mkdtempSync(join(tmpdir(), 'sd-jobs-'));
const before = process.env.KITOP_JOBS_DIR;
process.env.KITOP_JOBS_DIR = dir;
writeFileSync(join(dir, 'finite.ts'), `export default async (args, ctx) => { ctx.progress(0.5, 'working'); return args.value * 2; };`);
writeFileSync(join(dir, 'waiting.ts'), `export default async (args, ctx) => { ctx.signal.throwIfAborted(); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)); throw new Error('canceled'); };`);
afterAll(() => { stopAllJobs(); if (before === undefined) delete process.env.KITOP_JOBS_DIR; else process.env.KITOP_JOBS_DIR = before; rmSync(dir, { recursive: true, force: true }); });
test('finite jobs still complete with results and cancellation', async () => {
  const job = jobs.start('finite', { value: 21 });
  expect(await jobs.wait(job.id)).toMatchObject({ state: 'done', progress: 1, result: 42 });
  const waiting = jobs.start('waiting');
  jobs.cancel(waiting.id);
  expect(await jobs.wait(waiting.id)).toMatchObject({ state: 'canceled' });
});

test('a job whose app dies without a word leaves too', async () => {
  const child = resolve(import.meta.dir, 'child.ts');
  writeFileSync(join(dir, 'orphan-job.ts'), `import { runJob } from ${JSON.stringify(child)};\nrunJob(async () => { await Bun.write(${JSON.stringify(join(dir, 'orphan.pid'))}, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); });\n`);
  writeFileSync(join(dir, 'orphan-app.ts'), `const p = Bun.spawn([process.execPath, ${JSON.stringify(join(dir, 'orphan-job.ts'))}], { ipc(m) { if (m.t === 'ready') p.send({ t: 'start', id: 'x', args: null }); } }); await new Promise(() => {});\n`);
  const app = Bun.spawn([process.execPath, join(dir, 'orphan-app.ts')], { stdout: 'ignore', stderr: 'ignore' });
  const pidFile = join(dir, 'orphan.pid');
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(100);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(pid).toBeGreaterThan(0);
  app.kill(9);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(100);
  const stillAlive = alive();
  if (stillAlive) process.kill(pid, 9);
  expect(stillAlive).toBe(false);
}, 20_000);
