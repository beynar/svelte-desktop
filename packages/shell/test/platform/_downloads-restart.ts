// Helper for linux-web-downloads.ts (not a suite of its own): two runs of the same app, sharing their
// data directory. The first is killed with a pause and a transfer under way; the second finds them.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const base = process.env.DL_BASE!, slow = process.env.DL_SLOW!, dir = process.env.DL_DIR!, phase = process.env.DL_PHASE, ids = `${dir}/ids.json`;
const whole = Buffer.concat(Array.from({ length: 30 }, (_, i) => Buffer.alloc(64 * 1024, i + 1)));
const fast = Buffer.alloc(100000, 7);

export default async (t: Harness) => {
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  const record = async (id: string) => (await wv("getDownload", { id })).value;
  const until = async (id: string, ok: (r: any) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await record(id);
      if (r && ok(r)) return r;
      await t.sleep(20);
    }
    return record(id);
  };
  const history = `${process.env.XDG_DATA_HOME}/dev.kitop.harness/downloads.json`;
  if (phase === "1") {
    mkdirSync(dir, { recursive: true });
    await wv("setDownloadDirectory", { path: dir });
    const done = (await wv("download", { url: `${base}/fast.bin` })).value.id;
    t.check("first run: one finished", (await until(done, (r) => r.state === "completed")).state === "completed");
    const paused = (await wv("download", { url: `${slow}/slow/paused-restart.bin` })).value.id;
    await until(paused, (r) => r.receivedBytes > 0);
    t.check("first run: one paused", (await wv("pauseDownload", { id: paused })).value?.state === "paused");
    const inflight = (await wv("download", { url: `${slow}/slow/inflight.bin`, path: `${dir}/inflight.bin` })).value.id;
    const running = await until(inflight, (r) => r.receivedBytes >= 2 * 64 * 1024);
    t.check("first run: one under way", running.state === "downloading", running);
    t.check("the history is the app's own, private file", (statSync(history).mode & 0o777) === 0o600 && JSON.parse(readFileSync(history, "utf8")).length === 3, statSync(history).mode);
    writeFileSync(ids, JSON.stringify({ done, paused, inflight }));
    console.log("READY");
    await t.sleep(30000); // killed before this ends
    return;
  }
  if (phase === "2") {
    const { done, paused, inflight } = JSON.parse(readFileSync(ids, "utf8"));
    const list = (await wv("listDownloads")).value;
    t.check("second run: three records, newest first", list?.length === 3 && list[0].id === inflight && list[2].id === done, list);
    const finished = await record(done);
    t.check("a finished one stays finished, with its fields", finished.state === "completed" && finished.path === `${dir}/fast.bin` && finished.receivedBytes === fast.length && finished.fraction === 1 && finished.mimeType === "application/x-thing" && finished.windowId === 0 && finished.canResume === false, finished);
    const pausedNow = await record(paused);
    t.check("a paused one stays paused, resumable", pausedNow.state === "paused" && pausedNow.canResume === true && pausedNow.resumeBytes === 0, pausedNow);
    const lost = await record(inflight);
    t.check("what was under way is interrupted, and can start again", lost.state === "interrupted" && lost.canResume === true && lost.resumeBytes === 0, lost);
    t.check("the kill's partial file was tidied away", !existsSync(`${dir}/inflight.bin.wkdownload`), readdirSync(dir));
    t.check("the record says nothing of how it's stored", !("restartable" in lost), lost);
    t.check("nothing restarts by itself", (await wv("listDownloads")).value.every((d: any) => !["requested", "downloading"].includes(d.state)));
    const resumedOne = await wv("resumeDownload", { id: inflight });
    t.check("resume from the history", resumedOne.value?.state === "downloading" && resumedOne.value.receivedBytes === 0 && resumedOne.value.windowId === 0, resumedOne);
    const resumedTwo = await wv("resumeDownload", { id: paused });
    t.check("…the paused one too", resumedTwo.ok, resumedTwo);
    const one = await until(inflight, (r) => r.state === "completed");
    const two = await until(paused, (r) => r.state === "completed");
    t.check("both end with exactly what the server sends", readFileSync(`${dir}/inflight.bin`).equals(whole) && readFileSync(`${dir}/paused-restart.bin`).equals(whole), { one, two });
    t.check("the history says so", JSON.parse(readFileSync(history, "utf8")).filter((d: any) => d.state === "completed").length === 3);
  }
  if (phase === "3") {
    t.check("a history with odd records loads, past the ones it can't read", (await wv("getDownload", { id: "dl-odd" })).value?.state === "completed");
    t.check("a long history loads", (await wv("listDownloads")).value?.length === 251);
    const kept = (await wv("download", { url: `${base}/kept.bin`, path: `${dir}/kept.bin` })).value.id;
    await until(kept, (r) => r.state === "completed");
    const saved = JSON.parse(readFileSync(history, "utf8"));
    t.check("the history on disk is bounded: the newest 200", saved.length === 200 && saved[0].id === kept && saved[199].id === "dl-old-51", { length: saved.length, last: saved.at(-1)?.id });
  }
};
