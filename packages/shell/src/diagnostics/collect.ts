import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { arch, release, platform } from 'node:os';
import { findCrashReports, type CrashInfo, type CrashReport } from '../crash.ts';

export interface CollectOptions {
  /** Include app.log and its rotation; default true. */
  logs?: boolean;
  /** Include previous-run state and up to 20 recent OS reports; default true. */
  crashes?: boolean;
  /** Include app/OS/Bun version information; default true. */
  metadata?: boolean;
}
export interface SupportContext {
  logsDir: string;
  cacheDir: string;
  appName: string;
  executable: string;
  crashInfo(): CrashInfo;
  appInfo(): Promise<unknown>;
  /** @internal Fixture/report discovery override. */
  reports?(): CrashReport[];
}

/** Best effort masking, not a guarantee that arbitrary application data is safe to share. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\bAuthorization\b["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(\b(?:access_token|refresh_token|id_token|code_verifier|token|code)\b["']?\s*[:=]\s*["']?)[^\s&;,#}"']+/gi, '$1[REDACTED]');
}

export async function collectSupport(context: SupportContext, options: CollectOptions = {}): Promise<string> {
  const files: Record<string, string | Uint8Array> = {};
  const omitted: Array<{ file: string; reason: string }> = [];
  let total = 0;
  async function include(path: string, name: string, binary = false) {
    try {
      // Do not follow symlinks out of the app's log directory.
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || total + stat.size > 50 * 1024 * 1024) {
        omitted.push({ file: name, reason: 'not a regular file or size limit exceeded' }); return;
      }
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 10 * 1024 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        files[name] = binary ? bytes : redactSecrets(bytes.toString('utf8'));
        total += bytesRead;
      } finally { await file.close(); }
    } catch (error) { omitted.push({ file: name, reason: (error as NodeJS.ErrnoException).code ?? 'read failed' }); }
  }
  if (options.logs !== false) {
    try {
      const names = (await readdir(context.logsDir)).filter((name) => /^app\.log(?:\.\d+)?$/.test(name)).sort().slice(0, 10);
      for (const name of names) await include(join(context.logsDir, name), `logs/${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') omitted.push({ file: 'logs', reason: (error as NodeJS.ErrnoException).code ?? 'read failed' });
    }
  }
  if (options.crashes !== false) {
    files['crashes/previous-run.json'] = redactSecrets(JSON.stringify(context.crashInfo(), null, 2));
    try {
      const reports = (context.reports?.() ?? findCrashReports(context.executable)).sort((a, b) => b.time - a.time);
      if (reports.length > 20) omitted.push({ file: 'crashes', reason: 'only the newest 20 OS reports included' });
      for (const report of reports.slice(0, 20)) await include(report.path, `crashes/${basename(report.path)}`, report.path.endsWith('.dmp'));
    } catch (error) { omitted.push({ file: 'crashes', reason: (error as NodeJS.ErrnoException).code ?? 'discovery failed' }); }
  }
  if (options.metadata !== false) files['metadata.json'] = JSON.stringify({ app: await context.appInfo(), name: context.appName, os: platform(), release: release(), arch: arch(), bun: Bun.version, collectedAt: new Date().toISOString() }, null, 2);
  files['manifest.json'] = JSON.stringify({ format: 1, omitted }, null, 2);
  const dir = join(context.cacheDir, 'support');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `support-${Date.now()}-${crypto.randomUUID()}.tar.gz`);
  const archive = new Bun.Archive(files, { compress: 'gzip' });
  const output = await open(path, 'wx', 0o600);
  try { await output.writeFile(await archive.bytes()); }
  catch (error) { await unlink(path); throw error; }
  finally { await output.close(); }
  return path;
}
