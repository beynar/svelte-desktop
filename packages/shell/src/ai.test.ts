// host.ai's JavaScript side and its AI SDK model, against a fake native side (the model itself
// needs macOS 26 with Apple Intelligence on: tested in the apps).
import { beforeEach, expect, test } from "bun:test";
import { deliverPlatformEvent, initPlatformForTests } from "./platform/bus.ts";
import { ai } from "./ai.ts";
import { appleIntelligence } from "./ai-sdk.ts";

type Call = { id: number; service: string; op: string; args: Record<string, any> };
let calls: Call[] = [];
const reply = (id: number, value: unknown) => deliverPlatformEvent("platformResult", { id, ok: true, value });

beforeEach(() => {
  calls = [];
  initPlatformForTests({
    platformCall(raw) {
      const c = JSON.parse(raw) as Call;
      calls.push(c);
      const { id, op, args } = c;
      setTimeout(async () => {
        if (op === "availability") return reply(id, { available: true });
        if (op === "createSession") return reply(id, { session: "s1" });
        if (op === "cancel") return reply(id, null);
        if (op !== "respond") return reply(id, null);
        if (args.schema) return reply(id, { object: { title: "Call Sam", priority: "high" } });
        if (!args.stream) return reply(id, { text: `echo: ${args.prompt}` });
        let text = "";
        for (const delta of ["Hello", " desktop", " world"]) {
          text += delta;
          deliverPlatformEvent("ai.stream", { stream: args.stream, text, delta });
          await Bun.sleep(5);
        }
        reply(id, { text });
      }, 1);
      return '{"pending":true}';
    },
  });
});

test("respond, generate (the schema keeps its property order), stream, a session", async () => {
  expect(await ai.availability()).toEqual({ available: true });
  expect(await ai.respond("Hi", { instructions: "Be brief", temperature: 0.2, maxTokens: 50 })).toBe("echo: Hi");
  expect(calls.at(-1)!.args).toMatchObject({ prompt: "Hi", instructions: "Be brief", temperature: 0.2, maxTokens: 50 });
  const schema = { type: "object", properties: { title: { type: "string" }, priority: { enum: ["low", "high"] } }, required: ["title"] };
  expect(await ai.generate("Extract", { schema })).toEqual({ title: "Call Sam", priority: "high" });
  expect(calls.at(-1)!.args.schema["x-order"]).toEqual(["title", "priority"]);
  let out = "";
  for await (const piece of ai.stream("Say hello")) out += piece;
  expect(out).toBe("Hello desktop world");
  const chat = await ai.session({ instructions: "Terse" });
  expect(chat.id).toBe("s1");
  await chat.respond("My name is Ada");
  expect(calls.at(-1)!.args).toMatchObject({ session: "s1", prompt: "My name is Ada" });
  expect(calls.at(-1)!.args.instructions).toBeUndefined(); // the session's own
});

test("leaving a stream early cancels it", async () => {
  for await (const piece of ai.stream("Say hello")) {
    expect(piece).toBe("Hello");
    break;
  }
  expect(calls.some((c) => c.op === "cancel")).toBe(true);
});

test("the AI SDK model: generateText, streamText, a JSON output, warnings for what it can't do", async () => {
  const model = appleIntelligence({ instructions: "Be brief." });
  const g = await model.doGenerate({
    prompt: [
      { role: "system", content: "You help with tasks." },
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "assistant", content: [{ type: "text", text: "Ok" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ],
    temperature: 0.5,
    topK: 3,
  });
  expect(calls.at(-1)!.args).toMatchObject({ instructions: "Be brief.\n\nYou help with tasks.", prompt: "User: First\n\nAssistant: Ok\n\nSecond", temperature: 0.5 });
  expect(g.content).toEqual([{ type: "text", text: "echo: User: First\n\nAssistant: Ok\n\nSecond" }]);
  expect(g.warnings).toEqual([{ type: "unsupported", feature: "topK" }]);
  const j = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }], responseFormat: { type: "json", schema: { type: "object", properties: { title: { type: "string" } } } } });
  expect(JSON.parse(j.content[0]!.text)).toEqual({ title: "Call Sam", priority: "high" });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
  const parts: any[] = [];
  for await (const p of stream as any) parts.push(p);
  expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "text-delta", "text-delta", "text-end", "finish"]);
  expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("Hello desktop world");
});
