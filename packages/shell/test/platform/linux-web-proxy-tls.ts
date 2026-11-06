// `tls: true`: TLS to the proxy itself, with a proxy WebKit really trusts. The container's own trust
// store gets the test's certificate for this suite only (GIO reads it at the first TLS connection).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const STORE = "/etc/ssl/certs/ca-certificates.crt";

export default async (t: Harness) => {
  const policy = readFileSync(new URL("./linux-web-policy.ts", import.meta.url).pathname, "utf8");
  const CERT = policy.match(/const CERT = `([\s\S]*?)`/)![1]!, KEY = policy.match(/const KEY = `([\s\S]*?)`/)![1]!;
  const s = (op: string, args: Record<string, unknown> = {}) => t.call("sessions", op, args);
  await t.page(`document.cookie = '__kitop=gate; path=/'; return 1`);
  await s("create", { id: "tls", persistent: false });
  const untilText = async (id: string, text: string) => {
    for (let i = 0; i < 250; i++) {
      if ((await t.call("webview", "executeJavaScript", { viewId: id, code: `document.getElementById('p')?.textContent` })).value === text) return true;
      await t.sleep(20);
    }
    return false;
  };

  const before = existsSync(STORE) ? readFileSync(STORE, "utf8") : "";
  writeFileSync(STORE, before + "\n" + CERT); // before the first TLS connection
  try {
    // A plain port: what arrives is a TLS handshake, nothing in the clear.
    const raw: Buffer[] = [];
    const plain = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket, data) { raw.push(Buffer.from(data)); socket.end(); } } });
    await s("setProxy", { session: "tls", proxy: { type: "http", host: "127.0.0.1", port: plain.port, tls: true } });
    await t.call("view", "create", { id: "first", session: "tls", url: "http://secret-path.invalid/secret", bounds: { x: 0, y: 0, width: 200, height: 100 } });
    for (let i = 0; i < 200 && !raw.length; i++) await t.sleep(20);
    t.check("it opens with a TLS handshake", raw[0]?.[0] === 0x16, raw[0]?.subarray(0, 8));
    t.check("…the URL isn't in the clear", !Buffer.concat(raw).includes("secret-path"));
    await t.call("view", "destroy", { id: "first" });
    plain.stop(true);

    const seen: string[] = [];
    const proxy = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: CERT, key: KEY },
      socket: {
        data(socket, data) {
          const line = data.toString().split("\r\n")[0]!;
          seen.push(line);
          if (line.startsWith("CONNECT")) return void socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          const body = `<!doctype html><p id=p>via tls proxy</p>`;
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
          socket.end();
        },
      },
    });
    await s("setProxy", { session: "tls", proxy: { type: "http", host: "127.0.0.1", port: proxy.port, tls: true } });
    const shown = (await s("getProxy", { session: "tls" })).value;
    t.check("getProxy: tls true", shown?.tls === true, shown);
    await t.call("view", "create", { id: "second", session: "tls", url: "http://through-tls.invalid/x", bounds: { x: 0, y: 0, width: 200, height: 100 } });
    t.check("the page comes through a TLS proxy", await untilText("second", "via tls proxy"), seen);
    t.check("…which saw a CONNECT inside TLS, then the request", seen[0] === "CONNECT through-tls.invalid:80 HTTP/1.0" && seen[1] === "GET /x HTTP/1.1", seen);
    await t.call("view", "destroy", { id: "second" });
    proxy.stop(true);
  } finally {
    writeFileSync(STORE, before);
  }
  await s("setProxy", { session: "tls", proxy: null });
  await s("remove", { session: "tls" });
};
