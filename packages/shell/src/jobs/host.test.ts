import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
