// Desktop "hello world" benchmark harness: Electron vs Tauri 2 vs Electrobun vs ours.
//
//   bun bench.ts                 # all apps, 7 measured runs (+1 discarded first launch)
//   bun bench.ts tauri electron  # subset
//   RUNS=9 bun bench.ts
//
// Per app: .app size (du -sk), ditto zip size, DMG size (from the tool's own output),
// cold start (spawn -> GET /ready beacon, or our "type":"ready" stdout line), and at
// 3 s after spawn: phys_footprint (`footprint -p`) of every process attributed to the app,
// plus the process count. Everything launched is killed; the harness refuses to kill
// anything it did not attribute to the app under test.
//
// Launch method (identical for every app): `open -n -W [--env ...] [--stdout f] -a X.app`
// through LaunchServices, i.e. what a double-click does. This makes macOS treat the app as
// its own "responsible process", which is the only reliable way to attribute WebKit XPC
// helpers (WebContent / Networking / GPU are children of launchd, not of the app).
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BENCH = import.meta.dir;
const PORT = 47321;
const RUNS = Number(process.env.RUNS ?? 7);
const SAMPLE_AT_MS = 3000;
const SETTLED_AT_MS = Number(process.env.SETTLED_AT_MS ?? 10000); // second memory sample (0 = off): the WebKit GPU process is still volatile at 3 s
const TIMEOUT_MS = 30000;
const ART = join(BENCH, "artifacts");
mkdirSync(ART, { recursive: true });

type App = {
  key: string;
  label: string;
  app: string; // .app path
  dmg?: string; // DMG produced by the framework's own packager
  toolZip?: string; // zip produced by the framework's own packager (if any)
  ready: "beacon" | "stdout";
  alsoStdout?: boolean; // also record the `"type":"ready"` stdout line (ours only) to calibrate the two methods
  env?: Record<string, string>;
  // Directories the app creates outside its bundle that count as "installed size"
  // (Electrobun's self-extractor keeps its tarball in Application Support).
  extraInstalled?: string[];
};

const HOME = process.env.HOME!;
const APPS: App[] = [
  {
    key: "electron",
    label: "Electron (electron-builder)",
    app: join(BENCH, "electron/dist/mac-arm64/HelloElectron.app"),
    dmg: join(BENCH, "electron/dist/HelloElectron-1.0.0-arm64.dmg"),
    toolZip: join(BENCH, "electron/dist/HelloElectron-1.0.0-arm64-mac.zip"),
    ready: "beacon",
  },
  {
    key: "tauri",
    label: "Tauri 2 (tauri build)",
    app: join(BENCH, "tauri/src-tauri/target/release/bundle/macos/HelloTauri.app"),
    dmg: join(BENCH, "tauri/src-tauri/target/release/bundle/dmg/HelloTauri_0.1.0_aarch64.dmg"),
    ready: "beacon",
  },
  {
    key: "electrobun",
    label: "Electrobun (stable build)",
    app: join(BENCH, "electrobun/build/stable-macos-arm64/HelloElectrobun.app"),
    dmg: join(BENCH, "electrobun/artifacts/macos-arm64-HelloElectrobun.dmg"),
    ready: "beacon",
    extraInstalled: [join(HOME, "Library/Application Support/dev.bench.hello.electrobun")],
  },
  {
    key: "ours-minimal-stable",
    label: "Ours, minimal SvelteKit page (Bun 1.4.4 stable)",
    app: join(BENCH, "ours-builds/minimal-stable/HelloOurs.app"),
    dmg: join(BENCH, "ours-builds/minimal-stable/HelloOurs-1.0.0-darwin-arm64.dmg"),
    toolZip: join(BENCH, "ours-builds/minimal-stable/HelloOurs-1.0.0-darwin-arm64.zip"),
    ready: "beacon",
    alsoStdout: true,
    env: { SVELTE_DESKTOP_DEBUG: "1" },
  },
  {
    key: "ours-minimal-aot",
    label: "Ours, minimal SvelteKit page (Bun canary --aot --trim)",
    app: join(BENCH, "ours-builds/minimal-aot/HelloOurs.app"),
    dmg: join(BENCH, "ours-builds/minimal-aot/HelloOurs-1.0.0-darwin-arm64.dmg"),
    toolZip: join(BENCH, "ours-builds/minimal-aot/HelloOurs-1.0.0-darwin-arm64.zip"),
    ready: "beacon",
    alsoStdout: true,
    env: { SVELTE_DESKTOP_DEBUG: "1" },
  },
  {
    key: "ours-notes",
    label: "Ours, Notes example (SSR + sqlite + platform API)",
    app: join(BENCH, "ours-notes-snapshot/Notes.app"),
    dmg: join(BENCH, "ours-notes-snapshot/Notes-0.1.0-darwin-arm64.dmg"),
    toolZip: join(BENCH, "ours-notes-snapshot/Notes-0.1.0-darwin-arm64.zip"),
    ready: "stdout",
    env: { SVELTE_DESKTOP_DEBUG: "1" },
  },
];

// ---------------------------------------------------------------- process helpers
const libsys = dlopen("/usr/lib/libSystem.B.dylib", {
  responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
});
const responsible = (pid: number) => libsys.symbols.responsibility_get_pid_responsible_for_pid(pid);

type Proc = { pid: number; ppid: number; cmd: string };
function ps(): Proc[] {
  const out = Bun.spawnSync(["ps", "-axww", "-o", "pid=,ppid=,command="]).stdout.toString();
  return out
    .trim()
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m![1], ppid: +m![2], cmd: m![3] }));
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every process belonging to the app: binaries inside the bundle, their descendants, and
 * anything whose responsible process is one of those (WebKit XPC services etc.). */
function attributed(appPath: string): Proc[] {
  const all = ps();
  const set = new Map<number, Proc>();
  for (const p of all) if (p.cmd.startsWith(appPath + "/")) set.set(p.pid, p);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      if (set.has(p.pid)) continue;
      if (set.has(p.ppid) || (p.pid > 1 && set.has(responsible(p.pid)))) {
        set.set(p.pid, p);
        grew = true;
      }
    }
  }
  return [...set.values()];
}

function shortName(p: Proc) {
  const exe = p.cmd.split(" --")[0];
  const m = exe.match(/([^/]+)$/);
  return (m ? m[1] : exe).slice(0, 60);
}
function kindOf(p: Proc, appPath: string): "main" | "helper" | "system" {
  if (p.cmd.startsWith(appPath + "/Contents/MacOS/")) return "main";
  if (/Helper|com\.apple\.WebKit\./.test(p.cmd)) return "helper";
  return "system"; // shared system XPC services attributed to the app (MTLCompilerService, audio SandboxHelper...)
}

function footprintKB(pid: number): number | null {
  const r = Bun.spawnSync(["footprint", "-p", String(pid)]);
  const s = r.stdout.toString();
  const m = s.match(/phys_footprint:\s+([\d.]+)\s+(B|KB|MB|GB)/);
  if (!m) return null;
  const mult = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 * 1024 }[m[2] as "B"]!;
  return Math.round(+m[1] * mult);
}

async function killApp(appPath: string, launcher?: Bun.Subprocess) {
  for (let i = 0; i < 40; i++) {
    const procs = attributed(appPath);
    if (procs.length === 0) break;
    const sig = i < 10 ? "SIGTERM" : "SIGKILL";
    // Only signal processes that actually live in the bundle (+ their descendants).
    // WebKit XPC services exit on their own once their host is gone.
    for (const p of procs) if (p.cmd.startsWith(appPath + "/") || i >= 20) try { process.kill(p.pid, sig); } catch {}
    await Bun.sleep(250);
  }
  if (launcher) {
    try { launcher.kill("SIGKILL"); } catch {}
    await launcher.exited;
  }
  const left = attributed(appPath);
  if (left.length) throw new Error(`could not kill: ${left.map((p) => `${p.pid} ${shortName(p)}`).join(", ")}`);
}

// ---------------------------------------------------------------- ready beacon server
let readyWaiter: ((t: number) => void) | null = null;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const t = performance.now();
    if (new URL(req.url).pathname === "/ready" && readyWaiter) {
      readyWaiter(t);
      readyWaiter = null;
    }
    return new Response("ok", { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
  },
});

// ---------------------------------------------------------------- one launch
type Sample = { ms: number; stdoutMs?: number; settledKB: number | null; procs: { pid: number; name: string; kind: string; kb: number | null }[] };

async function launch(a: App, sampleMemory: boolean): Promise<Sample> {
  const stdoutFile = join(ART, `${a.key}.stdout.log`);
  rmSync(stdoutFile, { force: true });
  const args = ["open", "-n", "-W", "--stdout", stdoutFile, "--stderr", "/dev/null"];
  for (const [k, v] of Object.entries(a.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push("-a", a.app);

  let cancelPoll = false;
  const pollStdout = async () => {
    while (!cancelPoll) {
      try {
        if (readFileSync(stdoutFile, "utf8").includes('"type":"ready"')) return performance.now();
      } catch {}
      await Bun.sleep(2);
    }
    return NaN;
  };
  const beacon = a.ready === "beacon" ? new Promise<number>((res) => (readyWaiter = res)) : null;
  const stdoutReady = a.ready === "stdout" || a.alsoStdout ? pollStdout() : null;
  const readyAt = (beacon ?? stdoutReady)!;

  const t0 = performance.now();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ELECTRON_RUN_AS_NODE; // set by the host IDE; would turn Electron into plain Node
  const launcher = Bun.spawn(args, { env, stdout: "ignore", stderr: "ignore" });
  const timeout = Bun.sleep(TIMEOUT_MS).then(() => NaN);
  const t = await Promise.race([readyAt, timeout]);
  let stdoutMs: number | undefined;
  if (a.alsoStdout && stdoutReady) stdoutMs = (await Promise.race([stdoutReady, Bun.sleep(2000).then(() => NaN)])) - t0;
  cancelPoll = true;
  readyWaiter = null;
  const ms = t - t0;

  let procs: Sample["procs"] = [];
  const wait = SAMPLE_AT_MS - (performance.now() - t0);
  if (wait > 0) await Bun.sleep(wait);
  const ps3 = attributed(a.app);
  procs = ps3.map((p) => ({
    pid: p.pid,
    name: shortName(p),
    kind: kindOf(p, a.app),
    kb: sampleMemory ? footprintKB(p.pid) : null,
  }));
  let settledKB: number | null = null;
  if (sampleMemory && SETTLED_AT_MS) {
    await Bun.sleep(Math.max(0, SETTLED_AT_MS - (performance.now() - t0)));
    settledKB = attributed(a.app).reduce((acc, p) => acc + (footprintKB(p.pid) ?? 0), 0);
  }
  await killApp(a.app, launcher);
  return { ms, stdoutMs, procs, settledKB };
}

// ---------------------------------------------------------------- sizes
function duKB(p: string) {
  return +Bun.spawnSync(["du", "-sk", p]).stdout.toString().split("\t")[0];
}
const fileKB = (p?: string) => (p && existsSync(p) ? Math.round(statSync(p).size / 1024) : null);
function dittoZipKB(a: App) {
  const out = join(ART, `${a.key}.zip`);
  rmSync(out, { force: true });
  const r = Bun.spawnSync(["ditto", "-c", "-k", "--keepParent", a.app, out]);
  if (r.exitCode !== 0) throw new Error(`ditto failed for ${a.app}`);
  return fileKB(out);
}

// ---------------------------------------------------------------- main
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const only = process.argv.slice(2);
const results: any[] = [];
for (const a of APPS) {
  if (only.length && !only.includes(a.key)) continue;
  if (!existsSync(a.app)) {
    console.log(`\n== ${a.label}: SKIPPED (no bundle at ${a.app})`);
    results.push({ key: a.key, label: a.label, skipped: true });
    continue;
  }
  console.log(`\n== ${a.label}`);
  await killApp(a.app); // in case something is left over
  const sizeBefore = { appKB: duKB(a.app), dittoZipKB: dittoZipKB(a), dmgKB: fileKB(a.dmg), toolZipKB: fileKB(a.toolZip) };
  console.log(`  size: app ${sizeBefore.appKB} KB, ditto zip ${sizeBefore.dittoZipKB} KB, dmg ${sizeBefore.dmgKB} KB`);

  const samples: Sample[] = [];
  let first: Sample | null = null;
  for (let i = 0; i <= RUNS; i++) {
    const s = await launch(a, i > 0);
    if (i === 0) first = s;
    else samples.push(s);
    const mem = s.procs.reduce((acc, p) => acc + (p.kb ?? 0), 0);
    console.log(`  run ${i}${i === 0 ? " (discarded)" : ""}: ready ${s.ms.toFixed(0)} ms${s.stdoutMs ? ` (stdout ready ${s.stdoutMs.toFixed(0)})` : ""}${s.settledKB ? `, settled ${(s.settledKB / 1024).toFixed(1)} MB` : ""}, ${s.procs.length} procs${i ? `, ${(mem / 1024).toFixed(1)} MB` : ""}`);
    if (process.env.VERBOSE) for (const p of s.procs) console.log(`      ${p.kind} ${p.name} ${p.kb} KB`);
    await Bun.sleep(1000);
  }

  // Installed size after launching (Electrobun's self-extractor rewrites its own bundle).
  const installedKB = duKB(a.app) + (a.extraInstalled ?? []).filter(existsSync).reduce((s, d) => s + duKB(d), 0);

  const sum = (s: Sample, f: (k: string) => boolean) => s.procs.filter((p) => f(p.kind)).reduce((x, p) => x + (p.kb ?? 0), 0);
  const res = {
    key: a.key,
    label: a.label,
    ...sizeBefore,
    installedKB,
    firstLaunchMs: first!.ms,
    readyMs: samples.map((s) => s.ms),
    readyMedianMs: median(samples.map((s) => s.ms)),
    readyMinMs: Math.min(...samples.map((s) => s.ms)),
    readyMaxMs: Math.max(...samples.map((s) => s.ms)),
    stdoutReadyMedianMs: a.alsoStdout || a.ready === "stdout" ? median(samples.map((s) => (a.ready === "stdout" ? s.ms : s.stdoutMs ?? NaN))) : null,
    totalMinKB: Math.min(...samples.map((s) => sum(s, () => true))),
    totalMaxKB: Math.max(...samples.map((s) => sum(s, () => true))),
    settledTotalKB: median(samples.map((s) => s.settledKB ?? NaN)),
    loadAvg: Bun.spawnSync(["sysctl", "-n", "vm.loadavg"]).stdout.toString().trim(),
    mainKB: median(samples.map((s) => sum(s, (k) => k === "main"))),
    helpersKB: median(samples.map((s) => sum(s, (k) => k === "helper"))),
    systemKB: median(samples.map((s) => sum(s, (k) => k === "system"))),
    totalKB: median(samples.map((s) => sum(s, () => true))),
    procCount: median(samples.map((s) => s.procs.length)),
    engineProcCount: median(samples.map((s) => s.procs.filter((p) => p.kind !== "system").length)),
    lastSample: samples.at(-1)!.procs,
  };
  results.push(res);
  console.log(`  ready median ${res.readyMedianMs.toFixed(0)} ms; main ${(res.mainKB / 1024).toFixed(1)} MB, total ${(res.totalKB / 1024).toFixed(1)} MB, ${res.procCount} procs`);
}
server.stop(true);

const prev = existsSync(join(BENCH, "results.json")) ? await Bun.file(join(BENCH, "results.json")).json() : {};
for (const r of results) prev[r.key] = { ...r, measuredAt: new Date().toISOString() };
await Bun.write(join(BENCH, "results.json"), JSON.stringify(prev, null, 2));

// Markdown table
const mb = (kb: number | null | undefined) => (kb == null || !Number.isFinite(kb) ? "–" : (kb / 1024).toFixed(1));
const ms = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(0));
console.log("\n| app | .app MB | installed MB | zip MB | DMG MB | ready ms median (min–max) | main MB @3s | helpers MB @3s | total MB @3s (min–max) | total MB @10s | procs |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const k of Object.keys(prev)) {
  const r = prev[k];
  if (r.skipped) continue;
  console.log(
    `| ${r.label} | ${mb(r.appKB)} | ${mb(r.installedKB)} | ${mb(r.dittoZipKB)} | ${mb(r.dmgKB)} | ${ms(r.readyMedianMs)} (${ms(r.readyMinMs)}–${ms(r.readyMaxMs)}) | ${mb(r.mainKB)} | ${mb(r.helpersKB + r.systemKB)} | ${mb(r.totalKB)} (${mb(r.totalMinKB)}–${mb(r.totalMaxKB)}) | ${mb(r.settledTotalKB)} | ${r.procCount} |`,
  );
}
