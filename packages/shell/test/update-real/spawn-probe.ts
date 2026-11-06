// Temporary: which way of starting the update helper works on Windows.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const base = [ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const script = (n: number) => {
  const log = join(dir, `${n}.log`);
  const f = join(dir, `${n}.ps1`);
  writeFileSync(f, `Add-Content -LiteralPath '${log}' -Value 'ran'\n`);
  return { f, log };
};
let n = 0;
const direct: [string, Record<string, unknown>][] = [
  ['pipes', {}],
  ['stdio ignore', { stdio: ['ignore', 'ignore', 'ignore'] }],
  ['stdin ignore only', { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }],
  ['stdout+stderr ignore', { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }],
  ['detached, pipes', { detached: true }],
  ['detached, stdio ignore', { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }],
  ['hide, stdio ignore', { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }],
];
for (const [name, opts] of direct) {
  const { f, log } = script(n++);
  const t = Date.now();
  const p = Bun.spawn([...base, f], opts as never);
  const code = await p.exited;
  const err = p.stderr && typeof p.stderr !== 'number' ? await new Response(p.stderr as ReadableStream).text() : '';
  await Bun.sleep(500);
  console.log(`DIRECT ${existsSync(log) ? 'RAN   ' : "DIDN'T"} | ${name} | exit ${code} in ${Date.now() - t} ms | ${err.slice(0, 160)}`);
}
// The parent leaves at once, as the app does. Long enough to see it, this time.
const leaving: [string, string, string][] = [
  ['detached, ignore, parent exits', "detached: true, stdio: ['ignore', 'ignore', 'ignore']", 'process.exit(0)'],
  ['detached, ignore, parent stays 3 s', "detached: true, stdio: ['ignore', 'ignore', 'ignore']", 'await Bun.sleep(3000); process.exit(0)'],
  ['detached, hide, ignore, parent exits', "detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']", 'process.exit(0)'],
  ['detached, ignore, parent stays 500 ms', "detached: true, stdio: ['ignore', 'ignore', 'ignore']", 'await Bun.sleep(500); process.exit(0)'],
  ['detached, parent SIGTERM', "detached: true, stdio: ['ignore', 'ignore', 'ignore']", "process.kill(process.pid, 'SIGTERM')"],
];
for (const [name, opts, end] of leaving) {
  const { f, log } = script(n++);
  const parent = join(dir, `p${n}.ts`);
  writeFileSync(parent, `const p = Bun.spawn(${JSON.stringify([...base, f])}, { ${opts} }); p.unref(); ${end}`);
  const r = Bun.spawnSync([process.execPath, parent]);
  await Bun.sleep(15000);
  console.log(`LEAVE  ${existsSync(log) ? 'RAN   ' : "DIDN'T"} | ${name} | parent exit ${r.exitCode}`);
}
