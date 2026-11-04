// host.ai: the system's on-device language model, from pages and server code. On macOS 26 with
// Apple Intelligence on, Apple's Foundation Models (native/sdk/ai/AppleIntelligence.swift): free,
// offline, private. Elsewhere `available()` says why not and the calls reject `unavailable` /
// `unsupported`.
//
//   if ((await host.ai.availability()).available) {
//     const summary = await host.ai.respond(`Summarize: ${text}`);
//     const task = await host.ai.generate(`Extract the task: ${mail}`, { schema });   // JSON Schema
//     for await (const piece of host.ai.stream('Write a haiku')) out += piece;
//     const chat = await host.ai.session({ instructions: 'You are terse.' });       // keeps its turns
//   }
//
// The model is small (about 3 billion parameters): good at summarizing, extracting, classifying,
// rewriting and short answers, not at code, math or facts it would have to know.
import { callPlatform, NativeApiError, onPlatform } from "./platform/bus.ts";

export type AIUnavailableReason = "deviceNotEligible" | "appleIntelligenceNotEnabled" | "modelNotReady" | "unsupported" | "unavailable";

export interface AIAvailability {
  available: boolean;
  /** Why not: the Mac can't run it, Apple Intelligence is off (System Settings), the model is
   *  still downloading, or this OS has no on-device model (before macOS 26, Linux, Windows). */
  reason?: AIUnavailableReason;
}

export interface AIOptions {
  /** How the model should behave (a system prompt). Ignored inside a session: set it there. */
  instructions?: string;
  /** 0 (focused) to 2 (inventive). */
  temperature?: number;
  /** At most this many tokens in the response. */
  maxTokens?: number;
}

/** A JSON Schema the model's output must follow: objects (properties, required), arrays (minItems,
 *  maxItems), strings, string enums, integers, numbers, booleans, anyOf / oneOf, ["T", "null"].
 *  From zod: `z.toJSONSchema(schema)`. */
export type AISchema = Record<string, unknown>;

/** A conversation: each call sees the turns before it. */
export interface AISession {
  readonly id: string;
  respond(prompt: string, options?: Omit<AIOptions, "instructions">): Promise<string>;
  generate<T = unknown>(prompt: string, options: Omit<AIOptions, "instructions"> & { schema: AISchema }): Promise<T>;
  stream(prompt: string, options?: Omit<AIOptions, "instructions"> & { signal?: AbortSignal }): AsyncIterable<string>;
  close(): Promise<void>;
}

type Reply = { text?: string; object?: unknown; cancelled?: boolean };

/** The schema with `x-order` on each object: the property order the model writes them in (the
 *  native side's JSON objects don't keep it). */
function ordered(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(ordered);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, ordered(s)])) : ordered(v);
  if (out.properties && typeof out.properties === "object" && !out["x-order"]) out["x-order"] = Object.keys(out.properties);
  return out;
}

/** An ai op where the shell has none (Linux, Windows, no Swift toolchain): `unsupported`. */
const op = <T>(name: string, args: Record<string, unknown> = {}) =>
  callPlatform<T>("ai", name, args).catch((e: { code?: string }) => {
    throw e?.code === "unknown" ? new NativeApiError("unsupported", "host.ai: no on-device model on this system") : e;
  });
const respondOp = (args: Record<string, unknown>) => op<Reply>("respond", args);

/** A streamed response: each new piece of text (or each fuller object, with a schema) as it comes. */
async function* streamed<T>(args: Record<string, unknown>, pick: (e: { text?: string; delta?: string; object?: unknown }) => T, signal?: AbortSignal): AsyncGenerator<T> {
  const stream = crypto.randomUUID();
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  const off = onPlatform<{ stream: string; text?: string; delta?: string; object?: unknown }>("ai.stream", (e) => {
    if (e?.stream !== stream) return;
    queue.push(pick(e));
    wake?.();
  });
  const cancel = () => void callPlatform("ai", "cancel", { stream }).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  respondOp({ ...args, stream }).then(
    () => {
      finished = true;
      wake?.();
    },
    (e) => {
      failure = e;
      finished = true;
      wake?.();
    },
  );
  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    if (failure) throw failure;
  } finally {
    off();
    signal?.removeEventListener("abort", cancel);
    if (!finished) cancel(); // the loop was left early (break, return)
  }
}

function calls(session?: string) {
  const base = (prompt: string, o: AIOptions = {}) => ({ prompt, session, instructions: session ? undefined : o.instructions, temperature: o.temperature, maxTokens: o.maxTokens });
  return {
    respond: async (prompt: string, o: AIOptions = {}) => (await respondOp(base(prompt, o))).text ?? "",
    generate: async <T = unknown>(prompt: string, o: AIOptions & { schema: AISchema }) => (await respondOp({ ...base(prompt, o), schema: ordered(o.schema) })).object as T,
    stream: (prompt: string, o: AIOptions & { signal?: AbortSignal } = {}) => streamed(base(prompt, o), (e) => e.delta ?? "", o.signal),
    /** Each fuller version of the object as the model writes it, the last one complete. */
    streamObject: <T = unknown>(prompt: string, o: AIOptions & { schema: AISchema; signal?: AbortSignal }) => streamed({ ...base(prompt, o), schema: ordered(o.schema) }, (e) => e.object as Partial<T>, o.signal),
  };
}

export const ai = {
  /** Whether the on-device model can run now, and why not. */
  availability: () => callPlatform<AIAvailability>("ai", "availability").catch((): AIAvailability => ({ available: false, reason: "unsupported" })),
  ...calls(),
  /** A conversation that keeps its turns (and its instructions). Close it when done. */
  async session(options: { instructions?: string } = {}): Promise<AISession> {
    const { session: id } = await op<{ session: string }>("createSession", options);
    return { id, ...calls(id), close: () => op<null>("closeSession", { session: id }).then(() => {}) };
  },
};
