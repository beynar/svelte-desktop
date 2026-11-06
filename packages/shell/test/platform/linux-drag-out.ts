// shell.startDrag: a real press in the page starts a real XDND drag, dropped on another program's real target
// (test/docker/fake-drop.c), which says what it received.
import { writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]).stdout.toString().trim();
const position = (id: string) => Object.fromEntries(xdotool("getwindowgeometry", "--shell", id).split("\n").map((l) => l.split("="))) as Record<string, string>;

export default async (t: Harness) => {
  const a = "/tmp/kitop-drag-a.txt", b = "/tmp/kitop-drag b.txt";
  writeFileSync(a, "a");
  writeFileSync(b, "b");
  t.check("no button down → not_dragging", (await t.call("shell", "startDrag", { files: [a] })).error?.code === "not_dragging");
  t.check("no files → invalid_args", (await t.call("shell", "startDrag", {})).error?.code === "invalid_args");
  t.check("a missing file → invalid_args", (await t.call("shell", "startDrag", { files: ["/nope"] })).error?.code === "invalid_args");

  const target = Bun.spawn(["/tmp/fake-drop"], { stdout: "pipe", stderr: "ignore" });
  let drop = "";
  for (let i = 0; i < 50 && !drop; i++) {
    drop = xdotool("search", "--name", "fake-drop").split("\n").pop()!;
    await t.sleep(100);
  }
  await t.sleep(300);
  const reader = target.stdout.getReader();
  let received = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      received += new TextDecoder().decode(value);
    }
  })();
  const win = xdotool("search", "--onlyvisible", "--name", "^platform harness$").split("\n").pop()!;
  await t.page(`window.__result = null; document.body.style.cssText = 'margin:0;height:100vh'; window.__files = null;
    addEventListener('mousedown', async () => { window.__result = await pcall('shell', 'startDrag', window.__files); }); return 1`);
  const page = position(win), to = position(drop);
  const from = { x: Number(page.X) + 200, y: Number(page.Y) + 200 };
  const drag = async (files: unknown, x: number, y: number) => {
    await t.page(`window.__result = null; window.__files = ${JSON.stringify(files)}; return 1`);
    xdotool("windowraise", drop);
    xdotool("mousemove", String(from.x), String(from.y));
    await t.sleep(100);
    xdotool("mousedown", "1");
    await t.sleep(300); // the page's handler and its call
    for (let i = 1; i <= 8; i++) {
      xdotool("mousemove", String(from.x + ((x - from.x) * i) / 8), String(from.y + ((y - from.y) * i) / 8));
      await t.sleep(80);
    }
    await t.sleep(300);
    xdotool("mouseup", "1");
    for (let i = 0; i < 60; i++) {
      const r = await t.page<any>("return window.__result");
      if (r) return r;
      await t.sleep(100);
    }
    return null;
  };
  const dropped = await drag({ files: [a, b] }, Number(to.X) + 80, Number(to.Y) + 60);
  t.check("dropped on a target: {dropped: true}", dropped?.ok && dropped.value?.dropped === true, { dropped, page, to });
  await t.sleep(200);
  t.check("the target got both files as URIs", received.includes(`file://${a}`) && received.includes("file:///tmp/kitop-drag%20b.txt"), received);

  received = "";
  const missed = await drag({ files: [a] }, 1800, 1000); // the empty desktop
  t.check("dropped nowhere: {dropped: false}", missed?.ok && missed.value?.dropped === false, missed);
  t.check("… and nothing was received", received === "", received);
  await t.sleep(1000); // GTK slides a refused drag back before it can start another

  const icon = "/tmp/kitop-drag-icon.png";
  writeFileSync(icon, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));
  const iconed = await drag({ files: [a], icon }, Number(to.X) + 80, Number(to.Y) + 60);
  t.check("with an icon of its own: dropped", iconed?.value?.dropped === true && received.includes(`file://${a}`), { iconed, received });
  target.kill();
};
