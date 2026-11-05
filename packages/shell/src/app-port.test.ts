import { expect, test } from "bun:test";
import { appPorts, listenOnAppPort } from "./app-port.ts";

const busy = (code = "EADDRINUSE") => Object.assign(new Error("listen"), { code });

test("an app's ports: always the same, different per app, below the OS's outgoing ranges", () => {
  expect(appPorts("dev.x.notes")).toEqual(appPorts("dev.x.notes"));
  expect(appPorts("dev.x.notes")[0]).not.toBe(appPorts("dev.x.other")[0]);
  for (const id of ["dev.x.notes", "dev.x.other", "é.unicode", ""]) {
    const ports = appPorts(id);
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(10000);
      expect(port).toBeLessThan(32768);
    }
  }
});

test("the first free port, a real listener", () => {
  const ports = appPorts(`dev.test.${process.pid}`);
  const taken = Bun.serve({ hostname: "127.0.0.1", port: ports[0]!, fetch: () => new Response("") });
  const warn = console.warn;
  console.warn = () => {};
  const mine = listenOnAppPort(`dev.test.${process.pid}`, (port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") }));
  console.warn = warn;
  expect(mine.port).toBe(ports[1]!);
  void mine.stop(true);
  void taken.stop(true);
  // Free again: back on its own port, so one busy launch doesn't move the app for good.
  const again = listenOnAppPort(`dev.test.${process.pid}`, (port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") }));
  expect(again.port).toBe(ports[0]!);
  void again.stop(true);
});

test("every port taken: any free one; another failure isn't hidden", () => {
  const warn = console.warn;
  console.warn = () => {};
  const tried: number[] = [];
  const port = listenOnAppPort("dev.x.notes", (p) => {
    tried.push(p);
    if (p !== 0) throw busy();
    return p;
  });
  console.warn = warn;
  expect(port).toBe(0);
  expect(tried.length).toBe(9);
  expect(() => listenOnAppPort("dev.x.notes", () => { throw busy("EACCES"); })).toThrow("listen");
});
