/** WebSockets on the app's server (gate.ts + websocket.ts): behind the session cookie, on their paths. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startGate } from "./gate.ts";
import { defineWebSocket, sockets } from "./websocket.ts";

let gate: ReturnType<typeof startGate>;
let cookie = "";
const ws = (path: string, headers: Record<string, string> = { cookie }) => new WebSocket(`${gate.origin.replace("http", "ws")}${path}`, { headers } as never);
const first = (socket: WebSocket) =>
  new Promise<string>((resolve) => {
    socket.onmessage = (e) => resolve(String(e.data));
    socket.onerror = () => resolve("error");
    socket.onclose = (e) => resolve(`closed ${e.code}`);
  });

beforeAll(async () => {
  gate = startGate({
    handler: (req) => new Response(`app ${new URL(req.url).pathname}`),
    secret: "s",
    websocket: defineWebSocket<{ name: string }>({
      path: ["/ws", "/rooms/*"],
      upgrade: (req) => (new URL(req.url).searchParams.get("name") === "mallory" ? false : { name: new URL(req.url).searchParams.get("name") ?? "anon" }),
      open(s) {
        s.subscribe("all");
        s.send(`hi ${s.data.data.name} on ${s.data.path}`);
      },
      message(s, m) {
        s.send(`echo ${m}`);
      },
    }),
  });
  cookie = (await fetch(gate.authUrl("/"), { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
});
afterAll(() => gate.server.stop(true));

test("the app's page connects; messages go both ways; sockets.publish reaches it", async () => {
  const s = ws("/ws?name=ada");
  expect(await first(s)).toBe("hi ada on /ws");
  s.send("x");
  expect(await first(s)).toBe("echo x");
  const pushed = first(s);
  expect(sockets.publish("all", { type: "news" })).toBe(true);
  expect(await pushed).toBe('{"type":"news"}');
  expect(sockets.subscribers("all")).toBe(1);
  s.close();
});

test("prefix paths upgrade; other paths stay the app's", async () => {
  const s = ws("/rooms/42");
  expect(await first(s)).toBe("hi anon on /rooms/42");
  s.close();
  expect(await (await fetch(`${gate.origin}/rooms`, { headers: { cookie } })).text()).toBe("app /rooms");
});

test("refused without the session cookie, or when upgrade says no", async () => {
  expect(await first(ws("/ws", {}))).toMatch(/error|closed/);
  expect(await first(ws("/ws?name=mallory"))).toMatch(/error|closed/);
});

test("an Origin other than the app's is refused, even with the cookie", async () => {
  expect(await first(ws("/ws", { cookie, origin: "https://evil.example" }))).toMatch(/error|closed/);
  const own = ws("/ws?name=own", { cookie, origin: gate.origin });
  expect(await first(own)).toBe("hi own on /ws");
  own.close();
});

test("a failing open closes the socket (1011); sockets.publish stops with the server", async () => {
  const g2 = startGate({
    handler: () => new Response("app"),
    secret: "t",
    websocket: defineWebSocket({ path: "/ws", open() { throw new Error("setup failed"); }, message(s) { s.send("still here"); } }),
  });
  const c2 = (await fetch(g2.authUrl("/"), { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
  const s = new WebSocket(`${g2.origin.replace("http", "ws")}/ws`, { headers: { cookie: c2 } } as never);
  const closed = await new Promise<number>((resolve) => {
    s.onclose = (e) => resolve(e.code);
    s.onopen = () => s.send("x");
    s.onmessage = () => resolve(-1);
  });
  expect(closed).toBe(1011);
  expect(sockets.publish("all", "x")).toBe(true); // g2 is the current server
  g2.server.stop(true);
  expect(sockets.publish("all", "x")).toBe(false); // released with it
});
