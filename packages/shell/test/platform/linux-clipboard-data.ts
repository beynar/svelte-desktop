// clipboard.write and read, the rich calls: every representation published together, read back by another
// program (xclip, a real X11 client), and what another program owns read through the API.
import type { Harness } from "../harness-worker.ts";

const b64 = (s: string | Uint8Array) => Buffer.from(s as any).toString("base64");
const xclipOut = (target: string) => {
  const r = Bun.spawnSync(["timeout", "5", "xclip", "-selection", "clipboard", "-t", target, "-o"]);
  return { ok: r.exitCode === 0, bytes: Buffer.from(r.stdout) };
};
// 2×1: a red pixel, a blue one.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==";

export default async (t: Harness) => {
  const clip = (op: string, args: Record<string, unknown>) => t.call("clipboard", op, args);
  const binary = Uint8Array.from([0, 1, 2, 255, 0, 7]);
  const custom = { "application/x-kitop-test": b64(binary) };
  const tmp = `/tmp/kitop-clip-${process.pid}.txt`;
  await Bun.write(tmp, "x");
  const w = await clip("write", { text: "plain ✓", html: "<b>rich</b>", rtf: "{\\rtf1 hi}", image: PNG, files: [tmp], formats: custom });
  t.check("write: {changeCount, previousChangeCount}, the count moved", w.ok && typeof w.value.changeCount === "number" && w.value.changeCount > w.value.previousChangeCount, w);
  const targets = xclipOut("TARGETS").bytes.toString().split("\n");
  t.check("another program sees them all as targets", ["text/html", "text/rtf", "application/rtf", "image/png", "text/uri-list", "UTF8_STRING", "application/x-kitop-test"].every((x) => targets.includes(x)), targets);
  t.check("… text", xclipOut("UTF8_STRING").bytes.toString() === "plain ✓");
  t.check("… HTML", xclipOut("text/html").bytes.toString() === "<b>rich</b>");
  t.check("… RTF", xclipOut("text/rtf").bytes.toString() === "{\\rtf1 hi}");
  t.check("… a custom type, byte for byte, its zeros too", xclipOut("application/x-kitop-test").bytes.equals(Buffer.from(binary)));
  const png = xclipOut("image/png").bytes;
  t.check("… a PNG of the right size", png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === 2 && png.readUInt32BE(20) === 1, png.length);
  t.check("… the file as a URI", xclipOut("text/uri-list").bytes.toString().trim() === `file://${tmp}`);

  const r = await clip("read", { formats: ["text/plain", "text/html", "text/rtf", "image/png", "files", "application/x-kitop-test", "application/x-absent"] });
  const got = (f: string) => Buffer.from(r.value.formats[f] ?? "", "base64");
  t.check("read: the same count as the write", r.value?.changeCount === w.value.changeCount, r.value?.changeCount);
  t.check("read: text, HTML, RTF", got("text/plain").toString() === "plain ✓" && got("text/html").toString() === "<b>rich</b>" && got("text/rtf").toString() === "{\\rtf1 hi}");
  t.check("read: a custom type byte for byte", got("application/x-kitop-test").equals(Buffer.from(binary)));
  t.check("read: image and files", got("image/png").subarray(1, 4).toString() === "PNG" && got("files").toString().includes(`file://${tmp}`));
  t.check("read: what isn't there is null", r.value.formats["application/x-absent"] === null);
  const formats = (await t.call("clipboard", "availableFormats")).value as string[];
  t.check("availableFormats: the contract's names and the custom type, not X11's", ["files", "image/png", "text/html", "text/plain", "text/rtf", "application/x-kitop-test"].every((f) => formats.includes(f)) && !formats.some((f) => /^[A-Z]/.test(f) || f === "text/uri-list" || f.startsWith("text/plain;")), formats);
  t.check("has: a custom type", (await clip("has", { format: "application/x-kitop-test" })).value === true);

  // The clipboard another program owns.
  const owner = Bun.spawn(["xclip", "-selection", "clipboard", "-t", "application/x-foreign", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  owner.stdin.write(Buffer.from([9, 0, 8]));
  owner.stdin.end();
  await t.sleep(500);
  const foreign = await clip("read", { formats: ["application/x-foreign", "text/html"] });
  t.check("another program's type, read", foreign.ok && Buffer.from(foreign.value.formats["application/x-foreign"], "base64").equals(Buffer.from([9, 0, 8])) && foreign.value.formats["text/html"] === null, foreign);
  t.check("another program taking the clipboard moves the count", foreign.value?.changeCount > r.value.changeCount, foreign.value?.changeCount);
  t.check("… and the old contents are gone", (await clip("has", { format: "application/x-kitop-test" })).value === false);
  Bun.spawnSync(["pkill", "xclip"]);
  const again = await clip("write", { text: "a" });
  t.check("write after it: the count keeps going up", again.value.previousChangeCount >= foreign.value.changeCount && again.value.changeCount > again.value.previousChangeCount, again.value);

  const image = Bun.spawn(["xclip", "-selection", "clipboard", "-t", "image/png", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  image.stdin.write(Buffer.from(PNG, "base64"));
  image.stdin.end();
  await t.sleep(500);
  const fromOther = await clip("read", { formats: ["image/png"] });
  t.check("another program's PNG, as it is", fromOther.value?.formats["image/png"] === PNG, fromOther);
  Bun.spawnSync(["pkill", "xclip"]);

  // What's refused, and that a refusal leaves the clipboard alone.
  await clip("write", { text: "kept" });
  const bad = async (name: string, args: Record<string, unknown>) => t.check(`write ${name} → invalid_args`, (await clip("write", args)).error?.code === "invalid_args");
  await bad("nothing", {});
  await bad("a non-string text", { text: 1 });
  await bad("a bad image", { image: b64("not an image") });
  await bad("base64 that isn't", { formats: { "application/x-a": "!!!" } });
  await bad("a duplicate", { text: "a", formats: { "text/plain": b64("b") } });
  await bad("a relative file", { files: ["relative.txt"] });
  await bad("files twice", { files: [tmp], formats: { files: b64("x") } });
  await bad("over 16 MiB", { formats: { "application/x-big": b64(new Uint8Array(16 * 1024 * 1024 + 1)) } });
  t.check("… and the clipboard is as it was", (await t.call("clipboard", "readText")).value === "kept");
  t.check("read: formats are required", (await clip("read", {})).error?.code === "invalid_args");
  t.check("read: maxBytes must be in range", (await clip("read", { formats: ["text/plain"], maxBytes: 0 })).error?.code === "invalid_args");
  t.check("read: over maxBytes → invalid_args", (await clip("read", { formats: ["text/plain"], maxBytes: 2 })).error?.code === "invalid_args");
  t.check("read: from the page too", ((await t.pageCall("clipboard", "read", { formats: ["text/plain"] })) as any).value?.formats["text/plain"] === b64("kept"));
};
