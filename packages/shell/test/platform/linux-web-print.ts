// Printing on WebKitGTK: real PDFs on disk, read back (pages, paper, margins, the text on each page),
// the real GTK print dialog driven with real keys. No printer here: linux-web-print-cups has one.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";
import { readPdf } from "./_pdf.ts";

const ROOT = "/tmp/kitop-print";
const xdotool = (...args: string[]) => Bun.spawnSync(["xdotool", ...args]).stdout.toString().trim();

export default async (t: Harness) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const pdf = (name: string) => readPdf(readFileSync(`${ROOT}/${name}`));
  const printed = (n = 0) => (t.events.get("printFinished") ?? []).slice(n);
  const finishedCount = () => (t.events.get("printFinished") ?? []).length;
  await t.page(`document.body.innerHTML = ['FIRSTPAGE', 'SECONDPAGE', 'THIRDPAGE', 'FOURTHPAGE'].map((w, i) => '<p style="' + (i ? 'break-before: page' : '') + '">' + w + '</p>').join(''); return 1`);

  // ---- a PDF, for real -------------------------------------------------------------
  let at = finishedCount();
  const plain = await wv("printToPDF", { path: `${ROOT}/plain.pdf` });
  t.check("printToPDF → {path}", plain.ok && plain.value?.path === `${ROOT}/plain.pdf` && Object.keys(plain.value).length === 1, plain);
  const head = readFileSync(`${ROOT}/plain.pdf`).subarray(0, 5).toString();
  const doc = pdf("plain.pdf");
  t.check("a real PDF: %PDF header, the document's pages", head === "%PDF-" && doc?.pages === 4 && doc.media.length === 4, { head, doc });
  t.check("the page's text is in it, on the right pages", doc?.text[0].includes("FIRSTPAGE") && doc.text[1].includes("SECONDPAGE") && doc.text[3].includes("FOURTHPAGE") && !doc.text[0].includes("SECONDPAGE"), doc?.text);
  t.check("nothing but the file stays there", readdirSync(ROOT).join() === "plain.pdf", readdirSync(ROOT));
  await t.sleep(50);
  t.check("printFinished {success, path, source}", printed(at).length === 1 && printed(at)[0].success === true && printed(at)[0].path === `${ROOT}/plain.pdf` && printed(at)[0].windowId === 0, printed(at));
  t.check("printToPDF: no path → invalid_args", (await wv("printToPDF")).error?.code === "invalid_args");
  t.check("printToPDF: unknown view → invalid_args", (await wv("printToPDF", { path: `${ROOT}/x.pdf`, viewId: "nope" })).error?.code === "invalid_args");

  // print {pdfPath}: the other way to the same thing. ~ is the home directory.
  const viaPrint = await wv("print", { pdfPath: `${ROOT}/via-print.pdf` });
  t.check("print {pdfPath} → {success, path}", viaPrint.value?.success === true && viaPrint.value.path === `${ROOT}/via-print.pdf` && pdf("via-print.pdf")?.pages === 4, viaPrint);
  const tilde = await wv("printToPDF", { path: "~/kitop-print-test.pdf" });
  const home = `${process.env.HOME}/kitop-print-test.pdf`;
  t.check("~ expands", tilde.value?.path === home && existsSync(home), tilde);
  rmSync(home, { force: true });

  // A view prints itself, not the window it's in.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>the view</title><p>INSIDEVIEW</p>", { headers: { "content-type": "text/html" } }) });
  await t.call("view", "create", { id: "pv", url: `http://127.0.0.1:${server.port}/`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  for (let i = 0; i < 100 && !(await wv("executeJavaScript", { viewId: "pv", code: "document.readyState === 'complete' && !!document.querySelector('p')" })).value; i++) await t.sleep(20);
  at = finishedCount();
  await wv("printToPDF", { viewId: "pv", path: `${ROOT}/view.pdf` });
  const inView = pdf("view.pdf");
  t.check("a view prints itself", inView?.pages === 1 && inView.text[0].includes("INSIDEVIEW") && !inView.text[0].includes("FIRSTPAGE"), inView);
  await t.sleep(50);
  t.check("…and printFinished names it", printed(at)[0]?.viewId === "pv", printed(at));
  await t.call("view", "destroy", { id: "pv" });
  server.stop(true);

  // ---- options ---------------------------------------------------------------------
  await wv("printToPDF", { path: `${ROOT}/paper.pdf`, paperSize: { width: 300, height: 400 } });
  t.check("paperSize: the page is that size", pdf("paper.pdf")?.media.every((m) => m[2] === 300 && m[3] === 400), pdf("paper.pdf")?.media[0]);
  await wv("printToPDF", { path: `${ROOT}/land.pdf`, paperSize: { width: 300, height: 400 }, orientation: "landscape" });
  t.check("landscape: applied after the paper", pdf("land.pdf")?.media.every((m) => m[2] === 400 && m[3] === 300), pdf("land.pdf")?.media[0]);
  await wv("printToPDF", { path: `${ROOT}/margins.pdf`, paperSize: { width: 500, height: 600 }, margins: { top: 100, right: 40, bottom: 20, left: 60 } });
  const clip = pdf("margins.pdf")?.clip[0] ?? [];
  t.check("margins: the printable area is what they leave", Math.round(clip[0]) === 60 && Math.round(clip[1]) === 100 && Math.round(clip[2]) === 400 && Math.round(clip[3]) === 480, clip);
  await wv("printToPDF", { path: `${ROOT}/zero.pdf`, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  t.check("margins of zero", pdf("zero.pdf")?.clip[0][0] === 0 && pdf("zero.pdf")?.clip[0][1] === 0, pdf("zero.pdf")?.clip[0]);
  await wv("printToPDF", { path: `${ROOT}/copies.pdf`, copies: 3 });
  t.check("copies: a PDF doesn't repeat its pages", pdf("copies.pdf")?.pages === 4, pdf("copies.pdf")?.pages);
  await wv("printToPDF", { path: `${ROOT}/one.pdf`, pageRanges: [{ from: 3, to: 3 }] });
  t.check("pageRanges: that page, and no other", pdf("one.pdf")?.pages === 1 && pdf("one.pdf")!.text[0].includes("THIRDPAGE"), pdf("one.pdf"));
  await wv("printToPDF", { path: `${ROOT}/two.pdf`, pageRanges: [{ from: 1, to: 1 }, { from: 3, to: 4 }] });
  const two = pdf("two.pdf");
  t.check("pageRanges: several", two?.pages === 3 && two.text[0].includes("FIRSTPAGE") && two.text[1].includes("THIRDPAGE") && two.text[2].includes("FOURTHPAGE"), two);
  writeFileSync(`${ROOT}/past.pdf`, "kept");
  at = finishedCount();
  const past = await wv("printToPDF", { path: `${ROOT}/past.pdf`, pageRanges: [{ from: 3, to: 9 }] });
  t.check("pageRanges past the end → unavailable, and what was there stays", past.error?.code === "unavailable" && /past the end/.test(past.error.message) && readFileSync(`${ROOT}/past.pdf`, "utf8") === "kept", past);
  const beyond = await wv("printToPDF", { path: `${ROOT}/beyond.pdf`, pageRanges: [{ from: 8, to: 9 }] });
  t.check("pageRanges wholly past the end → unavailable", beyond.error?.code === "unavailable" && !existsSync(`${ROOT}/beyond.pdf`), beyond);
  await t.sleep(50);
  t.check("a failed job: printFinished says so", printed(at)[0]?.success === false, printed(at));
  t.check("…and leaves nothing behind", !readdirSync(ROOT).some((f) => f.startsWith(".sd-print")), readdirSync(ROOT));
  const nowhere = await wv("printToPDF", { path: "/nonexistent/dir/x.pdf" });
  t.check("a folder that isn't there → unavailable", nowhere.error?.code === "unavailable", nowhere);

  const bad: [string, Record<string, unknown>][] = [
    ["copies 0", { copies: 0 }], ["copies 1.5", { copies: 1.5 }], ["copies as a string", { copies: "2" }],
    ["paperSize without height", { paperSize: { width: 100 } }], ["paperSize too big", { paperSize: { width: 20000, height: 100 } }],
    ["orientation", { orientation: "sideways" }],
    ["margins missing one", { margins: { top: 1, right: 1, bottom: 1 } }], ["margins negative", { margins: { top: -1, right: 1, bottom: 1, left: 1 } }],
    ["margins leaving nothing", { paperSize: { width: 100, height: 100 }, margins: { top: 50, right: 0, bottom: 50, left: 0 } }],
    ["pageRanges empty", { pageRanges: [] }], ["pageRanges from 0", { pageRanges: [{ from: 0, to: 1 }] }], ["pageRanges backward", { pageRanges: [{ from: 3, to: 2 }] }],
    ["pageRanges overlapping", { pageRanges: [{ from: 1, to: 3 }, { from: 3, to: 4 }] }], ["pageRanges fractions", { pageRanges: [{ from: 1.5, to: 2 }] }],
  ];
  for (const [what, options] of bad) {
    const r = await wv("printToPDF", { path: `${ROOT}/bad.pdf`, ...options });
    t.check(`${what} → invalid_args`, r.error?.code === "invalid_args" && !existsSync(`${ROOT}/bad.pdf`), r);
  }
  t.check("physical printing: several ranges → invalid_args", (await wv("print", { silent: true, pageRanges: [{ from: 1, to: 1 }, { from: 3, to: 3 }] })).error?.code === "invalid_args");

  // ---- no printer here: nothing pretends otherwise ------------------------------------
  const printers = await wv("getPrinters");
  t.check("getPrinters: none here, and not GTK's Print to File", printers.ok && Array.isArray(printers.value) && printers.value.length === 0, printers);
  const silent = await wv("print", { silent: true });
  t.check("silent print with no printer → unavailable", silent.error?.code === "unavailable", silent);
  t.check("a printer that isn't installed → invalid_args", (await wv("print", { printer: "nope", silent: true })).error?.code === "invalid_args");
  t.check("Print to File isn't a printer to name", (await wv("print", { printer: "Print to File", silent: true })).error?.code === "invalid_args");

  // ---- the dialog ------------------------------------------------------------------
  const dialogWindows = () => xdotool("search", "--onlyvisible", "--name", "^Print$").split("\n").filter(Boolean);
  const dialogUp = async () => {
    for (let i = 0; i < 150 && !dialogWindows().length; i++) await t.sleep(20);
    return dialogWindows()[0];
  };
  const finishedAfter = async (n: number, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !printed(n).length) await t.sleep(20);
    return printed(n)[0];
  };
  at = finishedCount();
  const interactive = await wv("print");
  t.check("print: {started} once it's on its way", interactive.value?.started === true, interactive);
  let dialog = await dialogUp();
  t.check("a real GTK print dialog opens", !!dialog, xdotool("search", "--onlyvisible", "--name", "."));
  t.check("the app keeps working behind it", (await t.call("app", "getName")).ok);
  const another = await wv("print");
  t.check("a second one while it's open → unavailable", another.error?.code === "unavailable", another);
  xdotool("windowfocus", "--sync", dialog);
  xdotool("key", "--clearmodifiers", "Escape");
  const canceled = await finishedAfter(at);
  t.check("Escape: printFinished {success: false}", canceled?.success === false && canceled.windowId === 0, canceled);
  await t.sleep(200);
  t.check("…and it's closed", !dialogWindows().length, dialogWindows());

  // window.print() from the page goes the same way.
  at = finishedCount();
  await t.page("setTimeout(() => window.print(), 10); return 1");
  dialog = await dialogUp();
  t.check("window.print(): the same dialog", !!dialog);
  xdotool("windowfocus", "--sync", dialog);
  xdotool("key", "--clearmodifiers", "Escape");
  t.check("window.print(), canceled: printFinished {success: false}", (await finishedAfter(at))?.success === false, printed(at));
  await t.sleep(200);
  t.check("the page lives on", (await t.page("return 1 + 1")) === 2);

  // Print, in the dialog: GTK's own Print to File writes the file the settings name.
  rmSync(`${process.env.HOME}/output.pdf`, { force: true });
  rmSync(`${process.cwd()}/output.pdf`, { force: true });
  at = finishedCount();
  await wv("print", { paperSize: { width: 400, height: 300 } });
  dialog = await dialogUp();
  await t.sleep(600); // the printer list fills in
  xdotool("windowfocus", "--sync", dialog);
  xdotool("key", "--clearmodifiers", "Down"); // nothing's selected without a default printer
  await t.sleep(200);
  xdotool("key", "--clearmodifiers", "alt+p");
  const accepted = await finishedAfter(at, 6000);
  const out = [`${process.env.HOME}/output.pdf`, `${process.cwd()}/output.pdf`].find(existsSync);
  const outDoc = out ? readPdf(readFileSync(out)) : null;
  t.check("Print in the dialog: printFinished {success: true}, and the file, with the options the call gave", accepted?.success === true && outDoc?.media[0][2] === 400 && outDoc.media[0][3] === 300, { accepted, out, outDoc });
  if (out) rmSync(out, { force: true });
  for (const w of dialogWindows()) xdotool("windowclose", w);

  // Quitting with the dialog open: its own main loop mustn't keep the app alive.
  const harness = new URL("../harness.ts", import.meta.url).pathname, helper = new URL("./_print-quit.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, harness, helper], { stdout: "pipe", stderr: "ignore" });
  const quit = await Promise.race([child.exited.then((code) => code), Bun.sleep(15000).then(() => "still running")]);
  const said = await new Response(child.stdout).text().catch(() => "");
  if (quit === "still running") child.kill(9);
  t.check("the app quits with a print dialog open", quit === 0 && said.includes('"pass":true'), { quit, said: said.slice(-300) });
};
