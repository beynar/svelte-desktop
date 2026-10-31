/** What a job receives besides its arguments. */
export interface JobContext {
  readonly id: string;
  /** Aborted when the job is canceled (jobs.cancel) or the app quits. */
  readonly signal: AbortSignal;
  /** 0…1, with an optional status line. Throttled to the page store. */
  progress(fraction: number, message?: string): void;
  /** A line in the job's log (jobs.get(id).log). */
  log(...parts: unknown[]): void;
  /** A custom event for this job: pages get it as `jobEvent`, server code via jobs.on. */
  emit(data: unknown): void;
}

/** `src/jobs/<name>.ts`: `export default async function (args, ctx) { … return result }` */
export type JobFunction<A = any, R = unknown> = (args: A, ctx: JobContext) => R | Promise<R>;

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";

export interface JobInfo {
  id: string;
  name: string;
  state: JobState;
  progress: number;
  message: string | null;
  args: unknown;
  result?: unknown;
  error?: string;
  pid?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  log: string[];
  /** Loaded from a previous launch's history. */
  restored?: boolean;
}
