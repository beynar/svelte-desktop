import { afterAll, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { b64url, createPush, encryptWebPush, fromB64url, generateVapidKeys, PushError } from "./server.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

/** The user agent side of RFC 8291: decrypt an aes128gcm body. */
async function decryptWebPush(body: Uint8Array, ua: { publicKey: Uint8Array; privateKey: CryptoKey }, authSecret: Uint8Array) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, secret, cat(enc.encode("WebPush: info\0"), ua.publicKey, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.subarray(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return dec.decode(plain.subarray(0, -1));
}

async function userAgent() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { publicKey, privateKey: pair.privateKey, auth, keys: { p256dh: b64url(publicKey), auth: b64url(auth) } };
}

async function verifyJwt(token: string, key: CryptoKey, params: AlgorithmIdentifier | EcdsaParams) {
  const [h, c, s] = token.split(".");
  const ok = await crypto.subtle.verify(params, key, fromB64url(s), enc.encode(`${h}.${c}`));
  return { ok, header: JSON.parse(dec.decode(fromB64url(h))), claims: JSON.parse(dec.decode(fromB64url(c))) };
}

function pem(der: ArrayBuffer, label: string) {
  return `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;
}

describe("web push encryption (RFC 8291)", () => {
  test("matches the RFC 8291 appendix A example", async () => {
    const body = await encryptWebPush(
      enc.encode("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      {
        salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"),
        senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      },
    );
    expect(b64url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  test("round-trips with a fresh key pair", async () => {
    const ua = await userAgent();
    const body = await encryptWebPush(enc.encode('{"title":"hi"}'), ua.keys);
    expect(await decryptWebPush(body, ua, ua.auth)).toBe('{"title":"hi"}');
  });
});

describe("createPush", () => {
  const servers: { stop(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.stop()));

  test("web push: VAPID auth, encrypted payload, Topic from id, 410 = expired", async () => {
    const vapid = await generateVapidKeys();
    const ua = await userAgent();
    let seen: { headers: Headers; body: Uint8Array } | null = null;
    let gone = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = { headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) };
        return gone ? new Response("gone", { status: 410 }) : new Response(null, { status: 201, headers: { location: "/m/1" } });
      },
    });
    servers.push(server);
    const target = { provider: "webpush" as const, endpoint: `http://127.0.0.1:${server.port}/push/abc`, keys: ua.keys };
    const push = createPush({ webpush: { ...vapid, subject: "mailto:ops@example.com" } });
    const r = await push.send(target, { id: "msg-42", title: "Alice", body: "Lunch?", url: "/chat/42", data: { n: 1 } });
    expect(r.id).toBe("/m/1");
    const h = seen!.headers;
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("topic")).toBe("msg-42");
    expect(h.get("urgency")).toBe("high");
    const [, t, k] = h.get("authorization")!.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(vapid.publicKey);
    const pub = await crypto.subtle.importKey("raw", fromB64url(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const jwt = await verifyJwt(t, pub, { name: "ECDSA", hash: "SHA-256" });
    expect(jwt.ok).toBe(true);
    expect(jwt.claims.aud).toBe(`http://127.0.0.1:${server.port}`);
    expect(jwt.claims.sub).toBe("mailto:ops@example.com");
    const message = JSON.parse(await decryptWebPush(seen!.body, ua, ua.auth));
    expect(message).toMatchObject({ id: "msg-42", title: "Alice", body: "Lunch?" });
    expect(JSON.parse(message.payload)).toEqual({ url: "/chat/42", data: { n: 1 } });

    gone = true;
    const [result] = await push.sendMany([target], { title: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.expired).toBe(true);
  });

  test("apns: provider JWT, collapse id, payload, 410 = expired", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const p8 = pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
    const requests: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.on("data", (d) => (body += d));
      stream.on("end", () => {
        requests.push({ headers, body });
        if (String(headers[":path"]).endsWith("/gone")) {
          stream.respond({ ":status": 410, "content-type": "application/json" });
          stream.end(JSON.stringify({ reason: "Unregistered" }));
        } else {
          stream.respond({ ":status": 200, "apns-id": "abc-123" });
          stream.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push({ stop: () => server.close() });
    const port = (server.address() as { port: number }).port;
    const push = createPush({ apns: { teamId: "TEAM123456", keyId: "KEY1234567", key: p8, origin: `http://127.0.0.1:${port}` } });
    const target = { provider: "apns" as const, token: "deadbeef", topic: "dev.example.notes", environment: "development" as const };
    const r = await push.send(target, { id: "msg-42", title: "Alice", body: "Lunch?", url: "/chat/42", badge: 2, group: "chat" });
    expect(r.id).toBe("abc-123");
    const { headers, body } = requests[0];
    expect(headers[":path"]).toBe("/3/device/deadbeef");
    expect(headers["apns-topic"]).toBe("dev.example.notes");
    expect(headers["apns-collapse-id"]).toBe("msg-42");
    expect(headers["apns-push-type"]).toBe("alert");
    const jwt = await verifyJwt(String(headers.authorization).replace("bearer ", ""), pair.publicKey, { name: "ECDSA", hash: "SHA-256" });
    expect(jwt.ok).toBe(true);
    expect(jwt.header).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(jwt.claims.iss).toBe("TEAM123456");
    const json = JSON.parse(body);
    expect(json.aps).toEqual({ alert: { title: "Alice", body: "Lunch?" }, sound: "default", badge: 2, "thread-id": "chat" });
    expect(JSON.parse(json.sd)).toEqual({ url: "/chat/42" });

    await push.send(target, { background: true, data: { sync: true } });
    expect(requests[1].headers["apns-push-type"]).toBe("background");
    expect(requests[1].headers["apns-priority"]).toBe("5");
    expect(JSON.parse(requests[1].body).aps).toEqual({ "content-available": 1 });

    const err = await push.send({ ...target, token: "gone" }, { title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PushError);
    expect(err.expired).toBe(true);
    expect(err.reason).toBe("Unregistered");
    push.close();
  });

  test("fcm: OAuth assertion from the service account, v1 message, UNREGISTERED = expired", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    let assertion = "";
    let sent: { auth: string | null; body: any; path: string } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/token") {
          assertion = new URLSearchParams(await req.text()).get("assertion")!;
          return Response.json({ access_token: "ya29.test", expires_in: 3600 });
        }
        sent = { auth: req.headers.get("authorization"), body: await req.json(), path: url.pathname };
        if (sent.body.message.token === "gone")
          return Response.json({ error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 });
        return Response.json({ name: "projects/notes-app/messages/0:1" });
      },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const push = createPush({
      fcm: {
        serviceAccount: {
          project_id: "notes-app",
          client_email: "push@notes-app.iam.gserviceaccount.com",
          private_key: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY"),
          token_uri: `${origin}/token`,
        },
        origin,
      },
    });
    const r = await push.send({ provider: "fcm", token: "fcm-token" }, { id: "msg-42", title: "Alice", body: "Lunch?", url: "/chat/42", channel: "messages" });
    expect(r.id).toBe("projects/notes-app/messages/0:1");
    const jwt = await verifyJwt(assertion, pair.publicKey, { name: "RSASSA-PKCS1-v1_5" });
    expect(jwt.ok).toBe(true);
    expect(jwt.claims).toMatchObject({ iss: "push@notes-app.iam.gserviceaccount.com", aud: `${origin}/token`, scope: "https://www.googleapis.com/auth/firebase.messaging" });
    expect(sent!.path).toBe("/v1/projects/notes-app/messages:send");
    expect(sent!.auth).toBe("Bearer ya29.test");
    const m = sent!.body.message;
    expect(m.token).toBe("fcm-token");
    expect(m.notification).toEqual({ title: "Alice", body: "Lunch?" });
    expect(m.data).toEqual({ sd: JSON.stringify({ url: "/chat/42" }), sd_id: "msg-42" });
    expect(m.android.collapse_key).toBe("msg-42");
    expect(m.android.notification).toMatchObject({ tag: "msg-42", channel_id: "messages" });

    const err = await push.send({ provider: "fcm", token: "gone" }, { title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PushError);
    expect(err.expired).toBe(true);
    expect(err.reason).toBe("UNREGISTERED");
  });
});
