import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSupport, redactSecrets, type SupportContext } from './collect.ts';
const dir = mkdtempSync(join(tmpdir(), 'sd-support-'));
const logs = join(dir, 'logs');
mkdirSync(logs);
writeFileSync(join(logs, 'app.log'), 'GET /auth?code=secret-code&token=secret-token&ok=yes\nAuthorization: Bearer secret-header\n{"access_token":"secret-access"}\nuseful error\n');
writeFileSync(join(logs, 'app.log.1'), 'token=rotated-secret\n');
writeFileSync(join(dir, 'App-report.ips'), 'app crash report');
writeFileSync(join(logs, 'private.txt'), 'not a log');
symlinkSync(join(logs, 'private.txt'), join(logs, 'app.log.2'));
const context: SupportContext = {
  logsDir: logs, cacheDir: dir, appName: 'App', executable: 'App',
  crashInfo: () => ({ uncleanExit: true, previousLaunch: 123, reports: [] }),
  appInfo: async () => ({ version: '1.2.3', identifier: 'test.app' }),
  reports: () => [{ path: join(dir, 'App-report.ips'), time: 123 }, { path: join(dir, 'missing.ips'), time: 1 }],
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('archive contents, permissions, rotations, OS reports, omissions and redaction', async () => {
  const path = await collectSupport(context);
  // Windows has no such bits: the folder's ACL says who reads it.
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const files = await new Bun.Archive(await Bun.file(path).bytes()).files();
  expect([...files.keys()].sort()).toEqual(['crashes/App-report.ips', 'crashes/previous-run.json', 'logs/app.log', 'logs/app.log.1', 'manifest.json', 'metadata.json']);
  const text = await files.get('logs/app.log')!.text();
  expect(text).toContain('useful error'); expect(text).toContain('ok=yes');
  for (const secret of ['secret-code', 'secret-token', 'secret-header', 'secret-access']) expect(text).not.toContain(secret);
  expect(await files.get('logs/app.log.1')!.text()).not.toContain('rotated-secret');
  expect(JSON.parse(await files.get('crashes/previous-run.json')!.text()).uncleanExit).toBe(true);
  expect(JSON.parse(await files.get('metadata.json')!.text()).app.version).toBe('1.2.3');
  expect(JSON.parse(await files.get('manifest.json')!.text()).omitted).toHaveLength(2);
});

test('collection switches exclude data and do not call disabled sources', async () => {
  const nope = () => { throw new Error('disabled source accessed'); };
  const path = await collectSupport({ ...context, appInfo: nope, crashInfo: nope, reports: nope }, { logs: false, crashes: false, metadata: false });
  expect([... (await new Bun.Archive(await Bun.file(path).bytes()).files()).keys()]).toEqual(['manifest.json']);
});

test('redacts common query, JSON, assignment and header forms without losing ordinary diagnostics', () => {
  const text = redactSecrets('code=abc&token=def access_token = "ghi" {"token":"jkl"}\n"Authorization": "Bearer mno"\nauthorization=Basic pqr\nstatus=500');
  for (const secret of ['abc', 'def', 'ghi', 'jkl', 'mno', 'pqr']) expect(text).not.toContain(secret);
  expect(text).toContain('status=500');
});
