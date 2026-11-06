// Downloads on WebKitGTK against a real HTTP server: real files, real progress, real cancels, a
// server that fails. WebKitDownload can't pause or ask for a range, so a pause cancels and a resume
// downloads the file again: the server's requests prove it.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const CHUNK = 64 * 1024;
const COUNT = 30;
const whole = Buffer.concat(Array.from({ length: COUNT }, (_, i) => Buffer.alloc(CHUNK, i + 1)));
const fast = Buffer.alloc(100000, 7);
const gzipped = Buffer.from(Bun.gzipSync(Buffer.from("hi")));
const ROOT = "/tmp/kitop-downloads";

export default async (t: Harness) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const dir = `${ROOT}/saved`;
  const requests: { path: string; range: string | null; cookie: string | null; method: string }[] = [];
  const hits = (path: string) => requests.filter((r) => r.path === path);
  const aborted = new Set<string>(); // the server saw the transfer go away
  let cutHealed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({ path, range: req.headers.get("range"), cookie: req.headers.get("cookie"), method: req.method });
      const thing = { "content-type": "application/x-thing" };
      if (path === "/nolength") {
        return new Response(new ReadableStream({ async pull(c) { await Bun.sleep(50); c.enqueue(new Uint8Array(fast)); c.close(); } }), { headers: thing });
      }
      if (path === "/broken") return new Response("the error page", { status: 500, headers: thing });
      if (path === "/missing") return new Response("not here", { status: 404, headers: { "content-disposition": 'attachment; filename="missing.txt"' } });
      if (path === "/attachment") return new Response("an attachment", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="named by server.txt"' } });
      if (path === "/hostile") return new Response("escaped?", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="../../../hostile.txt"' } });
      if (path === "/nothing") return new Response(null, { status: 204 });
      if (path === "/text") return new Response("plain text", { headers: { "content-type": "text/plain" } });
      if (path === "/echo-cookie") return new Response(req.headers.get("cookie") ?? "(none)", { headers: thing });
      if (path.endsWith(".bin")) return new Response(fast, { headers: thing });
      return new Response(`<!doctype html><title>page</title>${path}`, { headers: { "content-type": "text/html", "set-cookie": "session=from-server; Path=/" } });
    },
  });
  // Bun.serve drops a stream's Content-Length, and never misbehaves: this one writes HTTP by hand.
  // /slow…: the whole file in timed chunks. /cut: says it has 100000 bytes, sends 1000 and hangs up.
  type Conn = { path: string; i: number; pending: Buffer; timer?: Timer; finished: boolean };
  const head = (length: number, extra = "") => `HTTP/1.1 200 OK\r\nContent-Type: application/x-thing\r\nContent-Length: ${length}\r\nConnection: close\r\n${extra}\r\n`;
  const pump = (s: any) => {
    const c: Conn = s.data;
    while (c.pending.length) {
      const n = s.write(c.pending);
      c.pending = c.pending.subarray(n);
      if (c.pending.length) return; // drain comes back
    }
    if (c.i === COUNT) {
      c.finished = true;
      return void s.end();
    }
    c.timer ??= setTimeout(() => {
      c.timer = undefined;
      c.pending = whole.subarray(c.i * CHUNK, ++c.i * CHUNK);
      pump(s);
    }, 80);
  };
  const raw = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s, buf) {
        if (s.data?.path) return;
        const text = buf.toString("latin1");
        const [method, path] = text.split(" ");
        requests.push({ path, method, range: /^range: (.*)$/im.exec(text)?.[1]?.trim() ?? null, cookie: null });
        s.data = { path, i: 0, pending: Buffer.alloc(0), finished: false };
        if (path.startsWith("/slow")) {
          s.write(head(whole.length, path === "/slowpost" ? 'Content-Disposition: attachment; filename="posted.bin"\r\n' : ""));
          return pump(s);
        }
        s.data.finished = true;
        if (path === "/gzip") s.write(Buffer.concat([Buffer.from(head(gzipped.length, "Content-Encoding: gzip\r\n")), gzipped]));
        else if (path === "/cut" && cutHealed) s.write(Buffer.concat([Buffer.from(head(fast.length)), fast]));
        else s.write(head(100000) + "z".repeat(1000));
        s.flush();
        setTimeout(() => s.end(), 100);
      },
      drain: pump,
      close(s) {
        if (s.data?.timer) clearTimeout(s.data.timer);
        if (s.data && !s.data.finished) aborted.add(s.data.path);
      },
    },
  });
  const slowBase = `http://127.0.0.1:${raw.port}`;
  const base = `http://127.0.0.1:${server.port}`;
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const record = async (id: string) => (await wv("getDownload", { id })).value;
  const seen = new Set<any>();
  async function nextEvent(name: string, id: string, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = (t.events.get(name) ?? []).find((x) => x.id === id && !seen.has(x));
      if (e) {
        seen.add(e);
        return e;
      }
      await t.sleep(10);
    }
    return null;
  }
  const events = (name: string, id: string) => (t.events.get(name) ?? []).filter((x) => x.id === id);
  async function ended(id: string, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await record(id);
      if (r && !["requested", "downloading", "pausing", "finishing"].includes(r.state)) return r;
      await t.sleep(20);
    }
    return record(id);
  }
  async function transferring(id: string, least = CHUNK, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await record(id);
      if (r?.state === "downloading" && r.receivedBytes >= least) return r;
      await t.sleep(10);
    }
    return record(id);
  }
  const start = async (url: string, path?: string, extra: Record<string, unknown> = {}) => (await wv("download", { url, ...(path ? { path } : {}), ...extra })).value?.id as string;
  const sameBytes = (path: string, bytes: Buffer) => existsSync(path) && readFileSync(path).equals(bytes);
  const noPartial = (folder: string) => !readdirSync(folder).some((f) => f.endsWith(".wkdownload"));

  // ---- the directory ---------------------------------------------------------------
  const home = (await wv("getDownloadDirectory")).value;
  t.check("the default directory is the system's", home?.path === (process.env.XDG_DOWNLOAD_DIR ?? `${process.env.HOME}/Downloads`) || /Downloads$/.test(home?.path ?? ""), home);
  const set = await wv("setDownloadDirectory", { path: dir });
  t.check("setDownloadDirectory creates it", set.value?.path === dir && statSync(dir).isDirectory() && (await wv("getDownloadDirectory")).value.path === dir, set);
  t.check("a directory it can't make → denied", (await wv("setDownloadDirectory", { path: "/proc/nope/nope" })).error?.code === "denied" && (await wv("getDownloadDirectory")).value.path === dir);
  const back = await wv("setDownloadDirectory", { path: null });
  t.check("null → back to the default", back.value?.path === home.path, back);
  await wv("setDownloadDirectory", { path: dir });

  // ---- arguments -------------------------------------------------------------------
  t.check("download: file: → invalid_args", (await wv("download", { url: "file:///etc/passwd" })).error?.code === "invalid_args");
  t.check("download: no url → invalid_args", (await wv("download")).error?.code === "invalid_args");
  t.check("download: relative path → invalid_args", (await wv("download", { url: `${base}/fast.bin`, path: "rel/x.bin" })).error?.code === "invalid_args");
  t.check("download: unknown view → invalid_args", (await wv("download", { url: `${base}/fast.bin`, viewId: "nope" })).error?.code === "invalid_args");
  t.check("getDownload: unknown → null", (await wv("getDownload", { id: "nope" })).value === null);

  // ---- a transfer: progress, destination, the bytes ----------------------------------
  const startedReply = await wv("download", { url: `${slowBase}/slow/one.bin` });
  const one = startedReply.value?.id as string;
  t.check("download → {id, url} at once", /^dl-/.test(one) && startedReply.value.url === `${slowBase}/slow/one.bin`, startedReply);
  const started = await nextEvent("downloadStarted", one);
  t.check("downloadStarted names the destination", started?.path === `${dir}/one.bin` && started.state === "downloading" && started.windowId === 0 && started.totalBytes === whole.length, started);
  const mid = await transferring(one, 3 * CHUNK);
  t.check("while it runs: getDownload says how far", mid?.state === "downloading" && mid.receivedBytes >= 3 * CHUNK && mid.receivedBytes < whole.length && mid.fraction > 0 && mid.fraction < 1, mid);
  t.check("listDownloads holds the live record", (await wv("listDownloads")).value?.some((d: any) => d.id === one && d.state === "downloading"));
  const finished = await nextEvent("downloadFinished", one, 8000);
  const progress = events("downloadProgress", one);
  t.check("downloadProgress: several, rising, with a fraction", progress.length >= 3 && progress.every((p, i) => p.fraction > 0 && p.fraction <= 1 && (i === 0 || p.receivedBytes >= progress[i - 1].receivedBytes)), progress.map((p) => p.receivedBytes));
  t.check("downloadChanged follows it", events("downloadChanged", one).length > progress.length);
  t.check("downloadFinished {bytes, path}", finished?.bytes === whole.length && finished.path === `${dir}/one.bin` && finished.windowId === 0, finished);
  t.check("the file holds exactly what the server sent", sameBytes(`${dir}/one.bin`, whole), statSync(`${dir}/one.bin`).size);
  const done = await record(one);
  t.check("the record: completed, the fields of the contract", done.state === "completed" && done.fraction === 1 && done.receivedBytes === whole.length && done.totalBytes === whole.length && done.mimeType === "application/x-thing" && done.suggestedFilename === "one.bin" && done.canResume === false && done.windowId === 0 && done.updatedAt >= done.startedAt && done.resumeData === undefined && done.error === undefined, done);
  t.check("resume: a completed one → unavailable", (await wv("resumeDownload", { id: one })).error?.code === "unavailable");
  t.check("pause: a completed one → unavailable", (await wv("pauseDownload", { id: one })).error?.code === "unavailable");
  t.check("cancel: a completed one → unavailable", (await wv("cancelDownload", { id: one })).error?.code === "unavailable");

  // Same name: a unique one beside it. No length: unknown, not zero.
  const first = await start(`${base}/again.bin`);
  await ended(first);
  const second = await start(`${base}/again.bin`);
  const secondEnd = await ended(second);
  t.check("the same name again → a unique name", secondEnd.path === `${dir}/again (1).bin` && sameBytes(`${dir}/again.bin`, fast) && sameBytes(`${dir}/again (1).bin`, fast), secondEnd);
  const list = (await wv("listDownloads")).value;
  t.check("listDownloads: newest first", list.findIndex((d: any) => d.id === second) < list.findIndex((d: any) => d.id === one), list.map((d: any) => d.path));
  const unknown = await start(`${base}/nolength`);
  const unknownMid = await record(unknown);
  const unknownEnd = await ended(unknown);
  t.check("no Content-Length: total -1, fraction -1 until it's done", unknownMid.totalBytes === -1 && unknownMid.fraction === -1 && unknownEnd.totalBytes === -1 && unknownEnd.fraction === 1 && unknownEnd.receivedBytes === fast.length, { unknownMid, unknownEnd });

  // An explicit path: exactly there, replacing what's there, folders made.
  const explicit = `${ROOT}/made/for/this/explicit.bin`;
  const ex = await start(`${base}/fast.bin`, explicit);
  t.check("download {path}: saved exactly there, folders made", (await ended(ex)).path === explicit && sameBytes(explicit, fast));
  writeFileSync(`${ROOT}/old.bin`, "stale");
  const rep = await start(`${base}/replace.bin`, `${ROOT}/old.bin`);
  t.check("download {path}: replaces what's there", (await ended(rep)).state === "completed" && sameBytes(`${ROOT}/old.bin`, fast));

  // The page's cookies, relative URLs.
  await t.page("document.cookie = 'dl=from-page; path=/'; return 1");
  const pageOrigin = await t.page<string>("return location.origin");
  const relative = (await wv("download", { url: "/download.txt" })).value;
  t.check("a relative URL means what it means in the page", relative?.url === `${pageOrigin}/download.txt`, relative);
  await ended(relative.id);
  await t.call("view", "create", { id: "dl", url: `${base}/start`, bounds: { x: 0, y: 0, width: 300, height: 200 } });
  const inView = async (code: string) => (await wv("executeJavaScript", { viewId: "dl", code })).value;
  for (let i = 0; i < 100 && (await inView("location.pathname")) !== "/start"; i++) await t.sleep(20);
  await inView("document.cookie = 'dl=view-cookie; path=/'; 1");
  const withCookie = (await wv("download", { url: "/echo-cookie", viewId: "dl", path: `${ROOT}/cookie.txt` })).value;
  const cookieEnd = await ended(withCookie.id);
  t.check("a download goes with the view's cookies, and names the view", readFileSync(`${ROOT}/cookie.txt`, "utf8").includes("dl=view-cookie") && cookieEnd.viewId === "dl" && cookieEnd.windowId === 0, cookieEnd);

  // ---- from the page itself --------------------------------------------------------
  const nextStarted = async (url: string) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const e = (t.events.get("downloadStarted") ?? []).find((x) => x.url === url && !seen.has(x));
      if (e) {
        seen.add(e);
        return e;
      }
      await t.sleep(10);
    }
    return null;
  };
  await inView(`location.href = '/attachment'; 1`);
  let fromPage = await nextStarted(`${base}/attachment`);
  let fromPageEnd = fromPage && (await ended(fromPage.id));
  t.check("an attachment the page opens is a download, under the server's name", fromPageEnd?.path === `${dir}/named by server.txt` && readFileSync(`${dir}/named by server.txt`, "utf8") === "an attachment" && fromPageEnd.viewId === "dl", fromPageEnd);
  await t.sleep(200);
  t.check("…and the page stays", (await inView("location.pathname")) === "/start");
  await inView(`location.href = '/shown.bin'; 1`);
  fromPage = await nextStarted(`${base}/shown.bin`);
  fromPageEnd = fromPage && (await ended(fromPage.id));
  t.check("a type the view can't show is a download", fromPageEnd?.state === "completed" && fromPageEnd.url === `${base}/shown.bin` && (await inView("location.pathname")) === "/start", fromPageEnd);
  const hostile = await start(`${base}/hostile`);
  const hostileEnd = await ended(hostile);
  t.check("a server's name can't leave the directory", hostileEnd.path === `${dir}/hostile.txt` && !existsSync(`${ROOT}/hostile.txt`), hostileEnd);
  const countBefore = (await wv("listDownloads")).value.length;
  await inView(`location.href = '/nothing'; 1`);
  await t.sleep(400);
  t.check("204 No Content isn't a download", hits("/nothing").length === 1 && (await wv("listDownloads")).value.length === countBefore && (await inView("location.pathname")) === "/start", hits("/nothing"));
  await inView(`(() => { const a = document.createElement('a'); a.href = '/text'; a.download = 'chosen.txt'; document.body.append(a); a.click(); return 1 })()`);
  fromPage = await nextStarted(`${base}/text`);
  fromPageEnd = fromPage && (await ended(fromPage.id));
  t.check("<a download> takes its name, even for what the view could show", fromPageEnd?.path === `${dir}/chosen.txt` && readFileSync(`${dir}/chosen.txt`, "utf8") === "plain text", fromPageEnd);
  const madeUrl = await t.page<string>(`const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['made in the page'], { type: 'text/plain' })); a.download = 'blob.txt'; document.body.append(a); a.click(); return a.href`);
  fromPage = await nextStarted(madeUrl);
  fromPageEnd = fromPage && (await ended(fromPage.id));
  t.check("<a download> on a blob: saves what the page made", fromPageEnd?.path === `${dir}/blob.txt` && readFileSync(`${dir}/blob.txt`, "utf8") === "made in the page" && fromPageEnd.windowId === 0 && fromPageEnd.canResume === false, fromPageEnd);
  const blob = await t.page<string>(`return URL.createObjectURL(new Blob(['a blob by call'], { type: 'text/plain' }))`);
  const byBlob = await start(blob, `${ROOT}/byblob.txt`);
  t.check("download of a blob: URL", (await ended(byBlob)).state === "completed" && readFileSync(`${ROOT}/byblob.txt`, "utf8") === "a blob by call");
  const byData = await start("data:text/plain,hello%20data", `${ROOT}/bydata.txt`);
  t.check("download of a data: URL", (await ended(byData)).state === "completed" && readFileSync(`${ROOT}/bydata.txt`, "utf8") === "hello data");

  // ---- cancel ----------------------------------------------------------------------
  const canceling = await start(`${slowBase}/slow/cancel.bin`);
  await transferring(canceling, 2 * CHUNK);
  const canceled = await wv("cancelDownload", { id: canceling, snapshot: true });
  t.check("cancel: the final record", canceled.value?.state === "canceled" && canceled.value.canResume === false && canceled.value.resumeBytes === undefined, canceled);
  const canceledEvent = await nextEvent("downloadFailed", canceling);
  t.check("downloadFailed {canceled: true, error: canceled}", canceledEvent?.canceled === true && canceledEvent.error === "canceled" && canceledEvent.canResume === false, canceledEvent);
  await t.sleep(300);
  t.check("the server saw it go, nothing stays on disk", aborted.has("/slow/cancel.bin") && !existsSync(`${dir}/cancel.bin`) && noPartial(dir), readdirSync(dir));
  t.check("cancel again → unavailable", (await wv("cancelDownload", { id: canceling })).error?.code === "unavailable");
  t.check("cancel: unknown id → invalid_args", (await wv("cancelDownload", { id: "nope" })).error?.code === "invalid_args");
  t.check("resume: canceled → unavailable", (await wv("resumeDownload", { id: canceling })).error?.code === "unavailable");
  const legacy = await start(`${slowBase}/slow/legacy.bin`);
  await transferring(legacy);
  const legacyReply = await wv("cancelDownload", { id: legacy });
  t.check("webview.cancelDownload answers null, as it does elsewhere", legacyReply.ok && (legacyReply.value ?? null) === null, legacyReply);
  t.check("…and it ends canceled", (await ended(legacy)).state === "canceled");

  // ---- a server that fails ---------------------------------------------------------
  const broken = await start(`${base}/broken`);
  const brokenEvent = await nextEvent("downloadFailed", broken);
  const brokenEnd = await ended(broken);
  t.check("HTTP 500: interrupted, says so", brokenEnd.state === "interrupted" && /500/.test(brokenEnd.error) && brokenEvent?.canceled === false && /500/.test(brokenEvent.error), { brokenEnd, brokenEvent });
  t.check("…no error page saved as the file", !existsSync(`${dir}/broken`) && brokenEnd.path === undefined && brokenEnd.canResume === false, readdirSync(dir));
  const missing = await start(`${base}/missing`);
  t.check("HTTP 404, an attachment: the same", /404/.test((await ended(missing)).error) && !existsSync(`${dir}/missing.txt`));
  const gz = await start(`${slowBase}/gzip`);
  const gzEnd = await ended(gz);
  t.check("Content-Encoding: decoded, and shorter than the length isn't a cut", gzEnd.state === "completed" && readFileSync(`${dir}/gzip`, "utf8") === "hi", gzEnd);
  const cut = await start(`${slowBase}/cut`);
  const cutEvent = await nextEvent("downloadFailed", cut);
  const cutEnd = await ended(cut);
  t.check("cut off halfway: interrupted, with the network's error", cutEnd.state === "interrupted" && !!cutEnd.error && /1000 of 100000/.test(cutEnd.error) && cutEvent?.canceled === false && cutEnd.receivedBytes === 1000 && cutEnd.totalBytes === 100000, { cutEnd, cutEvent });
  t.check("…nothing left on disk, and it can start again", !existsSync(`${dir}/cut`) && noPartial(dir) && cutEnd.canResume === true && cutEnd.resumeBytes === 0, { cutEnd, files: readdirSync(dir) });
  cutHealed = true;
  const cutResumed = await wv("resumeDownload", { id: cut });
  t.check("resume after the failure: the server came back, the whole file", cutResumed.ok && (await ended(cut)).state === "completed" && sameBytes(`${dir}/cut`, fast) && (await record(cut)).error === undefined, await record(cut));
  const nowhere = await start("http://127.0.0.1:1/refused.bin");
  const nowhereEnd = await ended(nowhere);
  t.check("nothing listening: interrupted", nowhereEnd.state === "interrupted" && !!nowhereEnd.error, nowhereEnd);

  // ---- pause and resume: a cancel, and the whole file again ----------------------------
  const pausing = await start(`${slowBase}/slow/paused.bin`);
  await transferring(pausing, 3 * CHUNK);
  const paused = await wv("pauseDownload", { id: pausing });
  t.check("pause: paused, resumable from byte 0, no resume data", paused.value?.state === "paused" && paused.value.canResume === true && paused.value.resumeBytes === 0 && paused.value.resumeData === undefined && paused.value.receivedBytes >= 3 * CHUNK, paused);
  const pausedEvent = await nextEvent("downloadFailed", pausing);
  t.check("downloadFailed {canceled: true, error: paused, canResume: true}", pausedEvent?.error === "paused" && pausedEvent.canceled === true && pausedEvent.canResume === true, pausedEvent);
  await t.sleep(300);
  t.check("a pause is a cancel: the server saw it go, the partial file is gone", aborted.has("/slow/paused.bin") && !existsSync(`${dir}/paused.bin`) && noPartial(dir), readdirSync(dir));
  t.check("pause again → unavailable", (await wv("pauseDownload", { id: pausing })).error?.code === "unavailable");
  t.check("cancel a paused one → unavailable, as on macOS", (await wv("cancelDownload", { id: pausing })).error?.code === "unavailable");
  t.check("pause: unknown id → invalid_args", (await wv("pauseDownload", { id: "nope" })).error?.code === "invalid_args");
  t.check("resume: unknown id → invalid_args", (await wv("resumeDownload", { id: "nope" })).error?.code === "invalid_args");
  t.check("resume: unknown view → invalid_args", (await wv("resumeDownload", { id: pausing, viewId: "nope" })).error?.code === "invalid_args");
  const startsBefore = events("downloadStarted", pausing).length;
  const occupier = await start(`${slowBase}/slow/occupier.bin`, `${dir}/paused.bin`);
  await transferring(occupier);
  t.check("resume while another transfer writes there → unavailable", (await wv("resumeDownload", { id: pausing })).error?.code === "unavailable");
  await wv("cancelDownload", { id: occupier, snapshot: true });
  const resumed = await wv("resumeDownload", { id: pausing });
  t.check("resume: the same record, from zero", resumed.value?.id === pausing && resumed.value.state === "downloading" && resumed.value.receivedBytes === 0 && resumed.value.canResume === false && resumed.value.path === `${dir}/paused.bin`, resumed);
  const resumedEnd = await nextEvent("downloadFinished", pausing, 8000);
  const asked = hits("/slow/paused.bin");
  t.check("the server was asked for the whole file twice: no Range, no byte-for-byte resume", asked.length === 2 && asked.every((r) => r.range === null), asked);
  t.check("…and the file is exactly what it sent", resumedEnd?.bytes === whole.length && sameBytes(`${dir}/paused.bin`, whole) && (await record(pausing)).state === "completed");
  t.check("a resume doesn't announce a new download", events("downloadStarted", pausing).length === startsBefore);

  // A POST can't be asked for again: it's a cancel with nothing to come back to.
  await inView(`(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '${slowBase}/slowpost'; document.body.append(f); f.submit(); return 1 })()`);
  const posted = await nextStarted(`${slowBase}/slowpost`);
  await transferring(posted?.id);
  const postPaused = await wv("pauseDownload", { id: posted?.id });
  t.check("pause of a POST: interrupted, canResume false", hits("/slowpost")[0]?.method === "POST" && postPaused.value?.state === "interrupted" && postPaused.value.canResume === false && postPaused.value.resumeBytes === undefined && !!postPaused.value.error, postPaused);
  t.check("…resume → unavailable", (await wv("resumeDownload", { id: posted?.id })).error?.code === "unavailable");
  const held = await start(`${slowBase}/slow/early.bin`);
  const earlyPause = await wv("pauseDownload", { id: held });
  t.check("pause before the first byte: no destination, nothing to resume to", earlyPause.value?.id === held && earlyPause.value.state === "interrupted" && earlyPause.value.canResume === false && /destination/.test(earlyPause.value.error), earlyPause);

  // ---- the server-owned decision ---------------------------------------------------
  const requested = async (id: string) => nextEvent("downloadRequested", id);
  t.check("setDownloadHandler: no id → invalid_args", (await wv("setDownloadHandler")).error?.code === "invalid_args");
  t.check("setDownloadHandler", (await wv("setDownloadHandler", { handlerId: "h1" })).ok);
  // Nobody answers this one: at the end, 30 seconds on, it's canceled.
  const abandonedAt = Date.now();
  const abandoned = await start(`${base}/abandoned.bin`);
  const abandonedAsk = await requested(abandoned);
  t.check("downloadRequested: what the handler needs", abandonedAsk?.handlerId === "h1" && abandonedAsk.suggestedFilename === "abandoned.bin" && abandonedAsk.mimeType === "application/x-thing" && abandonedAsk.size === fast.length && abandonedAsk.windowId === 0 && abandonedAsk.url === `${base}/abandoned.bin`, abandonedAsk);
  await t.sleep(400);
  t.check("while it decides: requested, no destination, nothing on disk", (await record(abandoned)).state === "requested" && (await record(abandoned)).path === undefined && !existsSync(`${dir}/abandoned.bin`) && !events("downloadStarted", abandoned).length);
  // Replacing the handler would cancel that one: a second one to decide, under the same handler.
  const chosen = await start(`${slowBase}/slow/chosen.bin`);
  await requested(chosen);
  t.check("decideDownload: another handler → unavailable", (await wv("decideDownload", { id: chosen, handlerId: "other", decision: "default" })).error?.code === "unavailable");
  const dest = `${ROOT}/decided/by/server.bin`;
  t.check("decideDownload {path}", (await wv("decideDownload", { id: chosen, handlerId: "h1", decision: { path: dest } })).ok);
  t.check("answering twice → unavailable", (await wv("decideDownload", { id: chosen, handlerId: "h1", decision: "default" })).error?.code === "unavailable");
  const chosenEnd = await ended(chosen);
  t.check("…the file goes where it said", chosenEnd.path === dest && sameBytes(dest, whole), chosenEnd);
  const dflt = await start(`${base}/fast.bin`, `${ROOT}/asked-for.bin`);
  await requested(dflt);
  await wv("decideDownload", { id: dflt, handlerId: "h1", decision: "default" });
  t.check("decision default: the path download was given", (await ended(dflt)).path === `${ROOT}/asked-for.bin` && sameBytes(`${ROOT}/asked-for.bin`, fast));
  const noPath = await start(`${base}/again.bin`);
  await requested(noPath);
  await wv("decideDownload", { id: noPath, handlerId: "h1", decision: "default" });
  t.check("decision default, no path: a unique name in the directory", (await ended(noPath)).path === `${dir}/again (2).bin`);
  const refused = await start(`${slowBase}/slow/refused.bin`);
  await requested(refused);
  await wv("decideDownload", { id: refused, handlerId: "h1", decision: "cancel" });
  const refusedEvent = await nextEvent("downloadFailed", refused);
  await t.sleep(300);
  t.check("decision cancel: canceled before saving, nothing on disk", refusedEvent?.canceled === true && refusedEvent.error === "canceled before saving" && (await record(refused)).state === "canceled" && !existsSync(`${dir}/refused.bin`) && noPartial(dir), refusedEvent);
  t.check("…and the transfer stopped", aborted.has("/slow/refused.bin"), [...aborted]);
  const invalid = await start(`${base}/fast.bin`);
  await requested(invalid);
  t.check("decision: a relative path → invalid_args, and canceled", (await wv("decideDownload", { id: invalid, handlerId: "h1", decision: { path: "rel.bin" } })).error?.code === "invalid_args" && (await ended(invalid)).state === "canceled");
  const wrongType = await start(`${base}/fast.bin`);
  await requested(wrongType);
  t.check("decision: a path that's no string → invalid_args, and canceled", (await wv("decideDownload", { id: wrongType, handlerId: "h1", decision: { path: 5 } })).error?.code === "invalid_args" && (await ended(wrongType)).state === "canceled");
  const toDir = await start(`${base}/fast.bin`);
  await requested(toDir);
  await wv("decideDownload", { id: toDir, handlerId: "h1", decision: { path: ROOT } });
  const toDirEnd = await ended(toDir);
  t.check("a directory as destination: interrupted", toDirEnd.state === "interrupted" && /directory/.test(toDirEnd.error), toDirEnd);
  const running = await start(`${slowBase}/slow/running.bin`);
  await requested(running);
  await wv("decideDownload", { id: running, handlerId: "h1", decision: { path: `${ROOT}/busy.bin` } });
  await transferring(running);
  const clash = await start(`${base}/fast.bin`);
  await requested(clash);
  await wv("decideDownload", { id: clash, handlerId: "h1", decision: { path: `${ROOT}/busy.bin` } });
  const clashEnd = await ended(clash);
  t.check("a destination another transfer writes: interrupted", clashEnd.state === "interrupted" && /in use/.test(clashEnd.error), clashEnd);
  await wv("cancelDownload", { id: running, snapshot: true });
  const pausedHeld = await start(`${base}/fast.bin`);
  await requested(pausedHeld);
  const pausedHeldReply = await wv("pauseDownload", { id: pausedHeld });
  t.check("pause while it decides: canceled before saving", pausedHeldReply.value?.state === "canceled", pausedHeldReply);
  const canceledHeld = await start(`${base}/fast.bin`);
  await requested(canceledHeld);
  t.check("cancel while it decides", (await wv("cancelDownload", { id: canceledHeld, snapshot: true })).value?.state === "canceled");

  // Wait out the handler's deadline, then what replacing and clearing do to a pending one.
  await t.sleep(Math.max(0, 28500 - (Date.now() - abandonedAt)));
  t.check("still held before the 30 seconds", (await record(abandoned)).state === "requested", await record(abandoned));
  await t.sleep(Math.max(0, 31000 - (Date.now() - abandonedAt)));
  const abandonedEnd = await record(abandoned);
  t.check("no answer in 30 seconds: canceled", abandonedEnd.state === "canceled" && events("downloadFailed", abandoned)[0]?.canceled === true && !existsSync(`${dir}/abandoned.bin`), abandonedEnd);
  t.check("…and the answer is too late", (await wv("decideDownload", { id: abandoned, handlerId: "h1", decision: "default" })).error?.code === "unavailable");

  const replaced = await start(`${base}/fast.bin`);
  await requested(replaced);
  await wv("setDownloadHandler", { handlerId: "h2" });
  t.check("a new handler cancels what was pending", (await record(replaced)).state === "canceled");
  await wv("clearDownloadHandler", { handlerId: "h1" });
  const stillH2 = await start(`${base}/fast.bin`);
  const stillAsk = await requested(stillH2);
  t.check("an older unsubscribe doesn't remove a newer handler", stillAsk?.handlerId === "h2", stillAsk);
  await wv("clearDownloadHandler", { handlerId: "h2" });
  t.check("clearing the handler cancels what was pending", (await record(stillH2)).state === "canceled");
  const free = await start(`${base}/again.bin`);
  t.check("no handler: no question", (await ended(free)).state === "completed" && !events("downloadRequested", free).length);
  await t.call("view", "destroy", { id: "dl" });

  // ---- across a restart: two more processes, the first killed halfway ------------------
  const data = `${ROOT}/xdg`;
  const helper = new URL("./_downloads-restart.ts", import.meta.url).pathname, harness = new URL("../harness.ts", import.meta.url).pathname;
  const env = { ...process.env, XDG_DATA_HOME: data, DL_BASE: base, DL_SLOW: slowBase, DL_DIR: `${ROOT}/restart` };
  const firstRun = Bun.spawn([process.execPath, harness, helper], { env: { ...env, DL_PHASE: "1" }, stdout: "pipe", stderr: "ignore" });
  let firstOut = "";
  const reader = firstRun.stdout.getReader();
  const decoder = new TextDecoder();
  const end = Date.now() + 20000;
  while (!firstOut.includes("READY") && Date.now() < end) {
    const { value, done: closed } = await Promise.race([reader.read(), Bun.sleep(20000).then(() => ({ value: undefined, done: true }))]);
    if (closed) break;
    firstOut += decoder.decode(value);
  }
  // A crash, or a power cut: nothing gets to say goodbye.
  firstRun.kill(9);
  await firstRun.exited;
  const secondRun = Bun.spawn([process.execPath, harness, helper], { env: { ...env, DL_PHASE: "2" }, stdout: "pipe", stderr: "ignore" });
  const secondOut = await new Response(secondRun.stdout).text();
  await secondRun.exited;
  // More than it keeps: the newest 200 reach the disk, as on Windows.
  const old = Array.from({ length: 250 }, (_, i) => ({ id: `dl-old-${i}`, url: `${base}/old`, state: "completed", startedAt: 1000 + i, updatedAt: 1000 + i, suggestedFilename: "old", mimeType: null, receivedBytes: 1, totalBytes: 1, fraction: 1, canResume: false }));
  // Hand-edited: wrong types where it's readable, not a record where it isn't.
  const odd = [{ id: "dl-odd", url: `${base}/odd`, state: "completed", path: 5, suggestedFilename: [], mimeType: {}, receivedBytes: "x", totalBytes: null, startedAt: "soon", restartable: "yes", error: 1 }, { id: 5 }, "nonsense"];
  writeFileSync(`${data}/dev.kitop.harness/downloads.json`, JSON.stringify([...old, ...odd]));
  const thirdRun = Bun.spawn([process.execPath, harness, helper], { env: { ...env, DL_PHASE: "3" }, stdout: "pipe", stderr: "ignore" });
  const thirdOut = await new Response(thirdRun.stdout).text();
  await thirdRun.exited;
  const lines = (firstOut + secondOut + thirdOut).split("\n").filter((l) => l.startsWith('{"check"'));
  for (const line of lines) {
    const c = JSON.parse(line);
    t.check(`restart: ${c.check}`, c.pass, c.detail);
  }
  t.check("restart: both runs reported", firstOut.includes("READY") && lines.length >= 15, (firstOut + secondOut + thirdOut).slice(-600));
  const asked2 = hits("/slow/inflight.bin");
  t.check("restart: the interrupted one was asked for from the start", asked2.length === 2 && asked2.every((r) => r.range === null), asked2);

  raw.stop(true);
  server.stop(true);
};
