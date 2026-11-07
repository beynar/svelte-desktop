// Launches one spike variant with the window kept open, waits for it to settle,
// then samples RSS + phys_footprint of the app process AND of the WebKit helper
// processes it spawned (WebContent / Networking / GPU are launchd XPC services,
// so they are found by diffing pgrep before/after).
import { $ } from "bun";

type Variant = { name: string; cmd: string[]; env?: Record<string, string> };
const C = "/tmp/bun-canary/bun-darwin-aarch64/bun";
const here = import.meta.dir;
const ONLY = process.env.ONLY;
const allVariants: Variant[] = [
  { name: "bun idle (no window)", cmd: ["bun", "-e", "setInterval(()=>{},1000)"] },
  { name: "bun idle + empty Worker", cmd: ["bun", "-e", "new Worker(URL.createObjectURL(new Blob(['setInterval(()=>{},1000)'])));setInterval(()=>{},1000)"] },
  { name: "window only (debug on)", cmd: ["bun", `${here}/main.ts`], env: { SPIKE_NO_WORKER: "1" } },
  { name: "window + worker (debug on)", cmd: ["bun", `${here}/main.ts`] },
  { name: "window + worker (debug off)", cmd: ["bun", `${here}/main.ts`], env: { SPIKE_DEBUG: "0" } },
  { name: "window + smol worker (debug off)", cmd: ["bun", `${here}/main.ts`], env: { SPIKE_DEBUG: "0", SPIKE_SMOL_WORKER: "1" } },
  { name: "--smol process, smol worker, debug off", cmd: ["bun", "--smol", `${here}/main.ts`], env: { SPIKE_DEBUG: "0", SPIKE_SMOL_WORKER: "1" } },
  { name: "compiled aot+trim, debug off", cmd: [`${here}/dist/spike-aot-trim`], env: { SPIKE_DEBUG: "0" } },
];
const variants = ONLY ? allVariants.filter((v) => v.name.includes(ONLY)) : allVariants;

const webkitPids = async () =>
  new Set((await $`pgrep -f com.apple.WebKit`.nothrow().text()).split("\n").filter(Boolean).map(Number));

async function sample(pid: number) {
  const rss = Number((await $`ps -o rss= -p ${pid}`.nothrow().text()).trim()) / 1024;
  const fp = await $`footprint -p ${pid}`.nothrow().text();
  const m = fp.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i) ?? fp.match(/phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/i);
  const unit = m?.[2]?.toUpperCase();
  const foot = m ? Number(m[1]) * (unit === "GB" ? 1024 : unit === "KB" ? 1 / 1024 : 1) : NaN;
  return { rss, foot };
}

const rows: string[] = [];
for (const v of variants) {
  const before = await webkitPids();
  const p = Bun.spawn(v.cmd, { env: { ...process.env, SPIKE_KEEP_OPEN: "1", ...v.env }, stdout: "ignore", stderr: "ignore", cwd: "/tmp" });
  await Bun.sleep(4000);
  const app = await sample(p.pid);
  const helpers = [...(await webkitPids())].filter((x) => !before.has(x));
  let hRss = 0, hFoot = 0;
  for (const h of helpers) { const s = await sample(h); hRss += s.rss || 0; hFoot += s.foot || 0; }
  p.kill(9);
  await p.exited;
  await Bun.sleep(1500); // let WebKit helpers wind down
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "?");
  rows.push(`| ${v.name} | ${f(app.rss)} | ${f(app.foot)} | ${helpers.length} | ${f(hFoot)} | ${f(app.foot + hFoot)} |`);
  console.log(rows.at(-1));
}
console.log("\n| variant | app RSS MB | app footprint MB | WebKit helpers | helpers footprint MB | total footprint MB |\n|---|---|---|---|---|---|\n" + rows.join("\n"));
