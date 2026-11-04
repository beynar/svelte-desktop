// The on-device model (host.ai) as a Vercel AI SDK model (ai 7, language model spec v4): the same
// code calls it or a cloud model.
//
//   import { generateText, streamText, generateObject } from 'ai';
//   import { appleIntelligence } from '@svelte-desktop/shell/ai-sdk';
//
//   const local = (await host.ai.availability()).available;
//   const model = local ? appleIntelligence() : openai('gpt-5-mini');
//   const { text } = await generateText({ model, prompt: 'Summarize…' });
//
// Supported: system / user / assistant text messages, temperature, maxOutputTokens, JSON output
// with a schema (generateObject, Output.object), streaming. Not supported (a warning each): tools,
// files and images, topP / topK / seed / stop sequences / penalties.
import { ai } from "./ai.ts";

// The parts of @ai-sdk/provider's LanguageModelV4 this model uses (no dependency on it).
type Part = { type: string; text?: string };
type Message = { role: "system"; content: string } | { role: "user" | "assistant" | "tool"; content: Part[] };
interface CallOptions {
  prompt: Message[];
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseFormat?: { type: "text" } | { type: "json"; schema?: Record<string, unknown>; name?: string; description?: string };
  tools?: unknown[];
  abortSignal?: AbortSignal;
}
type Warning = { type: "unsupported"; feature: string; details?: string };
const usage = () => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});
const stop = { unified: "stop" as const, raw: undefined };

/** The messages as one prompt for a fresh session: the system messages become its instructions,
 *  earlier turns a transcript before the last user message. */
function flatten(o: CallOptions): { instructions?: string; prompt: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const text = (parts: Part[]) =>
    parts
      .map((p) => {
        if (p.type === "text") return p.text ?? "";
        warnings.push({ type: "unsupported", feature: `${p.type} parts` });
        return "";
      })
      .join("");
  const system = o.prompt.filter((m) => m.role === "system").map((m) => m.content as string);
  const turns = o.prompt.filter((m): m is Extract<Message, { content: Part[] }> => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, text: text(m.content) }));
  const last = turns.at(-1);
  const prompt =
    turns.length <= 1
      ? (last?.text ?? "")
      : `${turns
          .slice(0, -1)
          .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
          .join("\n\n")}\n\n${last?.role === "user" ? "" : "Assistant: "}${last?.text ?? ""}`;
  for (const [key, feature] of [
    ["tools", "tools"],
    ["topP", "topP"],
    ["topK", "topK"],
    ["seed", "seed"],
    ["stopSequences", "stopSequences"],
    ["presencePenalty", "presencePenalty"],
    ["frequencyPenalty", "frequencyPenalty"],
  ] as const)
    if (o[key] !== undefined && !(Array.isArray(o[key]) && !(o[key] as unknown[]).length)) warnings.push({ type: "unsupported", feature });
  return { instructions: system.length ? system.join("\n\n") : undefined, prompt, warnings };
}

export interface AppleIntelligenceSettings {
  /** Instructions added before the call's own system messages. */
  instructions?: string;
}

export function appleIntelligence(settings: AppleIntelligenceSettings = {}) {
  const prepare = (o: CallOptions) => {
    const f = flatten(o);
    const instructions = [settings.instructions, f.instructions].filter(Boolean).join("\n\n") || undefined;
    const schema = o.responseFormat?.type === "json" ? (o.responseFormat.schema ?? { type: "object" }) : undefined;
    return { ...f, options: { instructions, temperature: o.temperature, maxTokens: o.maxOutputTokens }, schema };
  };
  return {
    specificationVersion: "v4" as const,
    provider: "apple",
    modelId: "apple-on-device",
    supportedUrls: {} as Record<string, RegExp[]>,

    async doGenerate(o: CallOptions) {
      const { prompt, options, schema, warnings } = prepare(o);
      const text = schema ? JSON.stringify(await ai.generate(prompt, { ...options, schema })) : await ai.respond(prompt, options);
      return { content: [{ type: "text" as const, text }], finishReason: stop, usage: usage(), warnings };
    },

    async doStream(o: CallOptions) {
      const { prompt, options, schema, warnings } = prepare(o);
      // With a schema, the model writes the object whole each time: the stream sends its JSON once.
      const pieces: AsyncIterable<string> = schema
        ? (async function* () {
            yield JSON.stringify(await ai.generate(prompt, { ...options, schema }));
          })()
        : ai.stream(prompt, { ...options, signal: o.abortSignal });
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: "0" });
          try {
            for await (const delta of pieces) if (delta) controller.enqueue({ type: "text-delta", id: "0", delta });
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue({ type: "finish", usage: usage(), finishReason: stop });
          } catch (error) {
            controller.enqueue({ type: "error", error });
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}
