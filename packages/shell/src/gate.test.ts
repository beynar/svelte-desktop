import { expect, test } from "bun:test";
import { secureCookiesForLoopback } from "./gate.ts";

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
