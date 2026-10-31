// Time from spawn to the window's `ready` event (DOMContentLoaded of the app page,
// i.e. the moment the window becomes visible), median of N runs.
// usage: bun measure-startup.ts <path/to/App.app> [runs]
const app = process.argv[2];
const runs = Number(process.argv[3] ?? 7);
const exe = `${app}/Contents/MacOS/${(await Bun.file(`${app}/Contents/Info.plist`).text()).match(/CFBundleExecutable<\/key><string>([^<]+)/)![1]}`;
const times: number[] = [];
for (let i = 0; i < runs + 1; i++) {
  const t0 = performance.now();
  const p = Bun.spawn([exe], { env: { ...process.env, SVELTE_DESKTOP_DEBUG: "1" }, stdout: "pipe", stderr: "ignore" });
  const reader = p.stdout.getReader();
  let buf = "";
  while (!buf.includes('"type":"ready"')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  const ms = performance.now() - t0;
  p.kill("SIGTERM");
  await p.exited;
  if (i > 0) times.push(ms); // first launch pays macOS's first-run scan of a new binary
  await Bun.sleep(300);
}
times.sort((a, b) => a - b);
console.log(`${app}: ready median ${times[times.length >> 1].toFixed(0)} ms (min ${times[0].toFixed(0)}, max ${times.at(-1)!.toFixed(0)}, n=${runs})`);
