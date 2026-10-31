// Inside a job process: runs the job's default export and talks to the app over IPC.
//   app → job  {t:'start', id, args} | {t:'cancel'}
//   job → app  {t:'progress', progress, message} | {t:'log', line} | {t:'emit', data}
//              {t:'done', result} | {t:'error', message}
import type { JobContext, JobFunction } from "./types.ts";

export function runJob(job: JobFunction) {
  const send = (m: unknown) => process.send?.(m);
  const controller = new AbortController();
  process.on("message", async (m: any) => {
    if (m?.t === "cancel") return controller.abort();
    if (m?.t !== "start") return;
    const ctx: JobContext = {
      id: m.id,
      signal: controller.signal,
      progress: (progress, message) => send({ t: "progress", progress: Math.max(0, Math.min(1, progress)), message: message ?? null }),
      log: (...parts) => send({ t: "log", line: parts.map((p) => (typeof p === "string" ? p : Bun.inspect(p))).join(" ") }),
      emit: (data) => send({ t: "emit", data }),
    };
    try {
      const result = await job(m.args, ctx);
      send({ t: "done", result: result ?? null });
    } catch (err) {
      send({ t: controller.signal.aborted ? "canceled" : "error", message: err instanceof Error ? err.message : String(err) });
    }
    // Let the last IPC message flush, then leave.
    setTimeout(() => process.exit(0), 20);
  });
  send({ t: "ready" });
}
