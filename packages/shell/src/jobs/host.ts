// Background jobs for server code: each job is a child process (the app's own
// executable with SVELTE_DESKTOP_JOB=<name>, which runs the job compiled into it;
// `bun src/jobs/x.ts` in dev), tracked here, mirrored to pages through the `jobs`
// broadcast channel.
// State lives on globalThis so the SvelteKit server bundle and the shell share it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobInfo, JobState } from "./types.ts";

export type { JobContext, JobFunction, JobInfo, JobState } from "./types.ts";

const NAMES = Symbol.for("svelte-desktop.jobs.names");
const STATE = Symbol.for("svelte-desktop.jobs");

interface Running {
  proc: ReturnType<typeof Bun.spawn>;
  resolve: (info: JobInfo) => void;
}

interface Registry {
  jobs: Map<string, JobInfo>;
  running: Map<string, Running>;
  queue: Array<{ id: string; options: StartOptions }>;
  waiters: Map<string, Array<(info: JobInfo) => void>>;
  listeners: Set<(info: JobInfo, event?: { type: "event"; data: unknown }) => void>;
  transitions: Set<(state: JobState, info: JobInfo) => void>;
  publish: ((snapshot: JobInfo[], extra?: Record<string, unknown>) => void) | null;
  seq: number;
  historyFile: string | null;
}

const R: Registry = ((globalThis as any)[STATE] ??= {
  jobs: new Map(),
  running: new Map(),
  queue: [],
  waiters: new Map(),
  listeners: new Set(),
  transitions: new Set(),
  publish: null,
  seq: 0,
  historyFile: null,
});

export interface StartOptions {
  /** At most this many jobs of the same name run at once; others wait. Default: unlimited. */
  concurrency?: number;
  /** Extra environment for the job process. */
  env?: Record<string, string>;
}

const HISTORY = 200;
const LOG_LINES = 200;

function sourcesDir(): string | null {
  return process.env.SVELTE_DESKTOP_JOBS_DIR ?? null;
}

/** The command for a job (argv + extra environment), or an error message. */
function command(name: string): { argv: string[]; env: Record<string, string> } | string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return `invalid job name "${name}"`;
  // `vite dev` (and tests): the source file, run by Bun.
  const dir = sourcesDir();
  if (dir) {
    const file = ["ts", "js"].map((e) => join(dir, `${name}.${e}`)).find((f) => existsSync(f));
    if (!file) return `no job "${name}" (expected src/jobs/${name}.ts)`;
    return { argv: [process.execPath, process.env.SVELTE_DESKTOP_JOBS_RUNNER ?? join(import.meta.dir, "dev-runner.ts"), file], env: {} };
  }
  // Packaged app: the job is compiled into the executable; it runs it when started with SVELTE_DESKTOP_JOB.
  const names = ((globalThis as any)[NAMES] as string[] | undefined) ?? [];
  if (!names.includes(name)) return `no job "${name}" (src/jobs/${name}.ts is bundled at build time)`;
  return { argv: [process.execPath], env: { SVELTE_DESKTOP_JOB: name } };
}

function snapshot(): JobInfo[] {
  return [...R.jobs.values()].map((j) => ({ ...j, log: j.log.slice(-20) }));
}

let publishTimer: ReturnType<typeof setTimeout> | null = null;
function changed(info: JobInfo, immediate = false, extra?: Record<string, unknown>) {
  for (const fn of R.listeners) {
    try {
      fn(info);
    } catch {}
  }
  if (!R.publish) return;
  if (immediate) {
    if (publishTimer) clearTimeout(publishTimer), (publishTimer = null);
    return R.publish(snapshot(), extra);
  }
  publishTimer ??= setTimeout(() => {
    publishTimer = null;
    R.publish?.(snapshot());
  }, 50);
}

function finish(id: string, state: JobState, patch: Partial<JobInfo>) {
  const info = R.jobs.get(id);
  if (!info || ["done", "failed", "canceled"].includes(info.state)) return;
  Object.assign(info, patch, { state, endedAt: Date.now() });
  if (state === "done") info.progress = 1;
  const run = R.running.get(id);
  R.running.delete(id);
  run?.resolve(info);
  for (const w of R.waiters.get(id) ?? []) w(info);
  R.waiters.delete(id);
  // Bounded history.
  const ended = [...R.jobs.values()].filter((j) => j.endedAt);
  for (const j of ended.slice(0, Math.max(0, ended.length - HISTORY))) R.jobs.delete(j.id);
  changed(info, true, { change: { type: state, job: { ...info, log: info.log.slice(-20) } } });
  transition(state, info);
  persist();
  pump();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Ended jobs survive restarts (<data>/jobs.json); running ones are recorded as canceled. */
function persist() {
  if (!R.historyFile) return;
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    const ended = [...R.jobs.values()].filter((j) => j.endedAt).map((j) => ({ ...j, log: j.log.slice(-50) }));
    try {
      writeFileSync(R.historyFile!, JSON.stringify(ended));
    } catch {}
  }, 200);
}

function launch(id: string, options: StartOptions) {
  const info = R.jobs.get(id)!;
  const cmd = command(info.name);
  if (typeof cmd === "string") return finish(id, "failed", { error: cmd });
  info.state = "running";
  info.startedAt = Date.now();
  let resolve!: (i: JobInfo) => void;
  void new Promise<JobInfo>((r) => (resolve = r));
  const proc = Bun.spawn(cmd.argv, {
    env: { ...process.env, ...options.env, ...cmd.env },
    stdout: "pipe",
    stderr: "pipe",
    ipc(m: any) {
      if (m?.t === "ready") proc.send({ t: "start", id, args: info.args });
      else if (m?.t === "progress") {
        info.progress = m.progress;
        info.message = m.message;
        changed(info);
      } else if (m?.t === "log") {
        info.log.push(m.line);
        if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES);
        changed(info);
      } else if (m?.t === "emit") {
        for (const fn of R.listeners) {
          try {
            fn(info, { type: "event", data: m.data });
          } catch {}
        }
        R.publish?.(snapshot(), { event: { id, data: m.data } });
      } else if (m?.t === "done") finish(id, "done", { result: m.result });
      else if (m?.t === "error") finish(id, "failed", { error: m.message });
      else if (m?.t === "canceled") finish(id, "canceled", { error: m.message });
    },
  });
  info.pid = proc.pid;
  R.running.set(id, { proc, resolve });
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) info.log.push(line);
        if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES);
      }
    })();
  }
  void proc.exited.then((code) => {
    const cur = R.jobs.get(id);
    if (cur && cur.state === "running") finish(id, cur.error === "canceled" ? "canceled" : "failed", { error: cur.error ?? `job process exited with code ${code}` });
  });
  changed(info, true, { change: { type: "running", job: { ...info, log: [] } } });
  transition("running", info);
}

function transition(state: JobState, info: JobInfo) {
  for (const fn of R.transitions) {
    try {
      fn(state, { ...info, log: [...info.log] });
    } catch {}
  }
}

function pump() {
  for (let i = 0; i < R.queue.length; ) {
    const { id, options } = R.queue[i]!;
    const info = R.jobs.get(id);
    if (!info || info.state !== "queued") {
      R.queue.splice(i, 1);
      continue;
    }
    const limit = options.concurrency ?? Infinity;
    const active = [...R.running.keys()].filter((r) => R.jobs.get(r)?.name === info.name).length;
    if (active < limit) {
      R.queue.splice(i, 1);
      launch(id, options);
    } else i++;
  }
}

export const jobs = {
  /** Start `src/jobs/<name>.ts` with `args` (JSON-serializable) in its own process. */
  start(name: string, args: unknown = null, options: StartOptions = {}): JobInfo {
    const id = `${name}-${Date.now().toString(36)}-${(++R.seq).toString(36)}`;
    const info: JobInfo = { id, name, state: "queued", progress: 0, message: null, args, createdAt: Date.now(), log: [] };
    R.jobs.set(id, info);
    R.queue.push({ id, options });
    changed(info, true, { change: { type: "queued", job: { ...info } } });
    transition("queued", info);
    pump();
    return { ...info };
  },
  /** Current state (a copy). */
  get(id: string): JobInfo | null {
    const j = R.jobs.get(id);
    return j ? { ...j, log: [...j.log] } : null;
  },
  /** Every job of this launch (running, queued and the last 200 ended), oldest first. */
  list(): JobInfo[] {
    return snapshot();
  },
  /** Resolves when the job ends (done, failed or canceled). */
  wait(id: string): Promise<JobInfo> {
    const j = R.jobs.get(id);
    if (!j) return Promise.reject(new Error(`unknown job ${id}`));
    if (j.endedAt) return Promise.resolve({ ...j });
    return new Promise((resolve) => R.waiters.set(id, [...(R.waiters.get(id) ?? []), (i) => resolve({ ...i })]));
  },
  /** Abort a job: its ctx.signal fires; the process is killed if it hasn't ended 2 s later. */
  cancel(id: string): boolean {
    const j = R.jobs.get(id);
    if (!j || j.endedAt) return false;
    if (j.state === "queued") {
      finish(id, "canceled", { error: "canceled" });
      return true;
    }
    const run = R.running.get(id);
    j.error = "canceled";
    try {
      run?.proc.send({ t: "cancel" });
    } catch {}
    setTimeout(() => {
      if (R.running.has(id)) {
        run?.proc.kill();
        finish(id, "canceled", { error: "canceled" });
      }
    }, 2000);
    return true;
  },
  /** Jobs queued or running. */
  active(): JobInfo[] {
    return snapshot().filter((j) => j.state === "queued" || j.state === "running");
  },
  /** Jobs running now. */
  running(): JobInfo[] {
    return snapshot().filter((j) => j.state === "running");
  },
  /** State transitions: `on('done', (job) => …)`; '*' for every one (queued, running, done, failed, canceled). */
  on(state: JobState | "*", fn: (job: JobInfo, state: JobState) => void): () => void {
    const cb = (s: JobState, info: JobInfo) => (state === "*" || state === s) && fn(info, s);
    R.transitions.add(cb);
    return () => R.transitions.delete(cb);
  },
  /** Custom events from `ctx.emit(data)` in jobs. */
  onEvent(fn: (e: { id: string; data: unknown }) => void): () => void {
    const cb = (info: JobInfo, event?: { type: "event"; data: unknown }) => event && fn({ id: info.id, data: event.data });
    R.listeners.add(cb);
    return () => R.listeners.delete(cb);
  },
};

/** @internal The shell wires the page channel, the quit hook and the history file. */
export function bindJobs(publish: (snapshot: JobInfo[], extra?: Record<string, unknown>) => void, historyFile?: string) {
  R.publish = publish;
  if (historyFile && !R.historyFile) {
    R.historyFile = historyFile;
    try {
      if (existsSync(historyFile))
        for (const j of JSON.parse(readFileSync(historyFile, "utf8")) as JobInfo[]) if (j?.id && !R.jobs.has(j.id)) R.jobs.set(j.id, { ...j, restored: true } as JobInfo);
    } catch {}
  }
}

/** @internal Kill every job (app quit). */
export function stopAllJobs() {
  for (const [id, run] of R.running) {
    try {
      run.proc.kill();
    } catch {}
    finish(id, "canceled", { error: "app quit" });
  }
  if (persistTimer) clearTimeout(persistTimer), (persistTimer = null);
  if (R.historyFile) {
    try {
      writeFileSync(R.historyFile, JSON.stringify([...R.jobs.values()].filter((j) => j.endedAt).map((j) => ({ ...j, log: j.log.slice(-50) }))));
    } catch {}
  }
}
