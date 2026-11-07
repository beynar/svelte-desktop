import { expect, test } from "bun:test";
import { PAGE_CRASHED_PATH, secureCookiesForLoopback, startGate } from "./gate.ts";

test("the page shown for a page that keeps crashing: behind the cookie, and its link stays on this server", async () => {
  const gate = startGate({ handler: () => new Response("app"), secret: "s3cret", appName: "A<b>" });
  try {
    const auth = await fetch(`${gate.origin}/__desktop/auth?t=s3cret`, { redirect: "manual" });
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const crashed = (to: string, headers: Record<string, string> = { cookie }) => fetch(`${gate.origin}${PAGE_CRASHED_PATH}?to=${encodeURIComponent(to)}`, { headers });

    expect((await crashed("/notes", {})).status).toBe(403);
    const page = await (await crashed("/notes?id=1")).text();
    expect(page).toContain('href="/notes?id=1"');
    expect(page).not.toContain("<b>");
    expect(await (await crashed("//example.com/")).text()).toContain('href="/"');
    expect(await (await crashed("/\\example.com/")).text()).toContain('href="/"');
    expect(await (await crashed("https://example.com/")).text()).toContain('href="/"');
    expect(await (await crashed('/"><script>')).text()).not.toContain("<script>");
  } finally {
    gate.server.stop(true);
  }
});

test("Secure / SameSite=None cookies are made storable on the http loopback origin", () => {
  const headers = new Headers();
  headers.append("set-cookie", "a=1; Path=/; HttpOnly; Secure; SameSite=Lax");
  headers.append("set-cookie", "b=2; Path=/; Secure");
  headers.append("set-cookie", "c=3; Path=/; SameSite=None; Secure");
  headers.append("set-cookie", "d=4; Path=/");
  const out = secureCookiesForLoopback(new Response("x", { status: 201, headers })).headers.getSetCookie();
  expect(out).toEqual(["a=1; Path=/; HttpOnly; SameSite=Lax", "b=2; Path=/", "c=3; Path=/; SameSite=Lax", "d=4; Path=/"]);
});

test("responses without Secure cookies pass through untouched", () => {
  const res = new Response("x", { headers: { "set-cookie": "d=4; Path=/" } });
  expect(secureCookiesForLoopback(res)).toBe(res);
});

test("HTML pages say who may have the camera, from the handler and from routes; an app's own header stays", async () => {
  const html = { "content-type": "text/html; charset=utf-8" };
  const gate = startGate({
    secret: "s",
    handler: (req) => (new URL(req.url).pathname === "/own" ? new Response("x", { headers: { ...html, "permissions-policy": "camera=*" } }) : new URL(req.url).pathname === "/data" ? Response.json({}) : new Response("<p>page", { status: 201, headers: html })),
    routes: {
      "/prerendered": { GET: () => new Response("<p>prerendered", { headers: html }) },
      "/app.js": { GET: () => new Response("1", { headers: { "content-type": "text/javascript" } }) },
    },
  });
  try {
    const auth = await fetch(`${gate.origin}/__desktop/auth?t=s`, { redirect: "manual" });
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) => fetch(`${gate.origin}${path}`, { headers: { cookie } });
    const page = await get("/");
    expect(page.headers.get("permissions-policy")).toContain("camera=(self)");
    expect([page.status, await page.text()]).toEqual([201, "<p>page"]);
    const prerendered = await get("/prerendered");
    expect(prerendered.headers.get("permissions-policy")).toContain("camera=(self)");
    expect(await prerendered.text()).toBe("<p>prerendered");
    expect((await get("/own")).headers.get("permissions-policy")).toBe("camera=*");
    expect((await get("/data")).headers.has("permissions-policy")).toBe(false);
    expect((await get("/app.js")).headers.has("permissions-policy")).toBe(false);
  } finally {
    gate.server.stop(true);
  }
});
