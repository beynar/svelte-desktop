// Temporary: which way of starting the update helper survives the app's exit on Windows.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const base = [ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const variants: Record<string, { argv: (s: string) => string[]; opts: string; end?: string }> = {
  'current: detached + hide + -WindowStyle Hidden': { argv: (s) => [...base, '-WindowStyle', 'Hidden', '-File', s], opts: 'detached: true, windowsHide: true' },
  'detached + hide, no -WindowStyle': { argv: (s) => [...base, '-File', s], opts: 'detached: true, windowsHide: true' },
  'detached, no hide, no -WindowStyle': { argv: (s) => [...base, '-File', s], opts: 'detached: true' },
  'detached, no hide, -WindowStyle Hidden': { argv: (s) => [...base, '-WindowStyle', 'Hidden', '-File', s], opts: 'detached: true' },
  'hide, not detached, -WindowStyle Hidden': { argv: (s) => [...base, '-WindowStyle', 'Hidden', '-File', s], opts: 'windowsHide: true' },
  'hide, not detached, no -WindowStyle': { argv: (s) => [...base, '-File', s], opts: 'windowsHide: true' },
  'detached + hide, no -WindowStyle, SIGTERM': { argv: (s) => [...base, '-File', s], opts: 'detached: true, windowsHide: true', end: "process.kill(process.pid, 'SIGTERM')" },
  'detached + hide, no -WindowStyle, stays 3 s': { argv: (s) => [...base, '-File', s], opts: 'detached: true, windowsHide: true', end: 'await Bun.sleep(3000); process.exit(0)' },
};
let i = 0;
for (const [name, v] of Object.entries(variants)) {
  const n = i++;
  const log = join(dir, `${n}.log`);
  const script = join(dir, `${n}.ps1`);
  writeFileSync(script, `Add-Content -LiteralPath '${log}' -Value 'ran'\n`);
  const code = `const p = Bun.spawn(${JSON.stringify(v.argv(script))}, { ${v.opts}, stdio: ['ignore', 'ignore', 'ignore'] }); p.unref(); ${v.end ?? 'process.exit(0)'}`;
  const parent = join(dir, `${n}.ts`);
  writeFileSync(parent, code);
  const r = Bun.spawnSync([process.execPath, parent], { stdout: 'pipe', stderr: 'pipe' });
  await Bun.sleep(5000);
  console.log(`${existsSync(log) ? 'RAN   ' : 'DIDN\'T'} | ${name} | parent exit ${r.exitCode} ${r.stderr.toString().slice(0, 120)}`);
}
