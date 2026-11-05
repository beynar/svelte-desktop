// The Python SDK (native/sdk/python) and its bridge, with a uv-managed CPython (skipped without uv).
import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describePython, pythonSources } from "./python.ts";

const tmp = mkdtempSync(join(tmpdir(), "sd-python-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SDK = resolve(import.meta.dir, "../../native/sdk/python");
const hasUv = !!Bun.which("uv");
const python = hasUv ? (await $`uv python find --managed-python 3.12`.nothrow().text()).trim() || (await $`uv python install 3.12 -q && uv python find --managed-python 3.12`.nothrow().text()).trim() : "";

const app = join(tmp, "native", "python");
mkdirSync(app, { recursive: true });
writeFileSync(
  join(app, "text.py"),
  `from __future__ import annotations
import asyncio, enum
from dataclasses import dataclass, field
from typing import Literal, NotRequired, Optional, TypedDict
from kitop import command, emit, InvalidArgs

class Mode(enum.Enum):
    FAST = "fast"
    EXACT = "exact"

@dataclass
class Stats:
    words: int
    top: list[tuple[str, int]] = field(default_factory=list)

class Opts(TypedDict):
    mode: Literal["a", "b"]
    limit: NotRequired[int]

@dataclass
class Point:
    x: float
    y: float = 0

@command("text.stats")
def stats(text: str, lowercase: bool = False) -> Stats:
    print("stdout is the log, not the protocol")
    return Stats(words=len(text.split()))

@command("text.slow")
async def slow(ms: int, opts: Opts | None = None, mode: Mode = Mode.FAST) -> dict[str, float]:
    await asyncio.sleep(ms / 1000)
    emit("text.done", {"ms": ms})
    return {"ms": ms, "nan": float("nan")}

@command("text.fail")
def fail() -> None:
    raise InvalidArgs("nope\\nsecond line")

@command("text.crash")
def crash(x: int) -> Optional[str]:
    return str(1 / x)

@command("geo.norm")
def norm(p: Point, extra: list[Point | None]) -> float:
    return (p.x ** 2 + p.y ** 2) ** 0.5
`,
);
writeFileSync(join(app, "test_text.py"), "raise SystemExit('test files are not imported')\n");

test("native/python/ is found when it holds modules", () => {
  expect(pythonSources({ native: join(tmp, "native") })).toBe(app);
  expect(pythonSources({ native: join(tmp, "nope") })).toBeNull();
  expect(pythonSources({ native: null })).toBeNull();
});

test.skipIf(!hasUv)("describe: the commands' TypeScript types from their annotations", async () => {
  const d = await describePython(python, app);
  expect(d.language).toBe("python");
  expect(Object.fromEntries(d.commands.map((c) => [`${c.service}.${c.op}`, [c.args, c.result]]))).toEqual({
    "geo.norm": ["{ p: { x: number; y?: number }; extra: ({ x: number; y?: number } | null)[] }", "number"],
    "text.crash": ["{ x: number }", "string | null"],
    "text.fail": [null, "null"],
    "text.slow": ['{ ms: number; opts?: { mode: "a" | "b"; limit?: number } | null; mode?: "fast" | "exact" }', "Record<string, number>"],
    "text.stats": ["{ text: string; lowercase?: boolean }", "{ words: number; top: [string, number][] }"],
  });
}, 60_000);

test.skipIf(!hasUv)("run: replies, errors, events on the protocol; print() never corrupts it", async () => {
  const calls = [
    { id: 1, service: "text", op: "stats", args: { text: "a b c" } },
    { id: 2, service: "text", op: "slow", args: { ms: 30, opts: { mode: "a" } } },
    { id: 3, service: "text", op: "fail", args: {} },
    { id: 4, service: "text", op: "crash", args: { x: 0 } },
    { id: 5, service: "text", op: "stats", args: { nope: 1 } },
    { id: 6, service: "text", op: "stats", args: {} },
    { id: 7, service: "text", op: "missing", args: {} },
    { id: 8, service: "geo", op: "norm", args: { p: { x: 3, y: 4 }, extra: [] } },
    { id: 9, service: "geo", op: "norm", args: { p: { z: 1 }, extra: [] } },
  ];
  const proc = Bun.spawn([python, "-B", "-m", "kitop", "run", app], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: SDK } });
  proc.stdin.write(calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
  await proc.stdin.flush();
  await Bun.sleep(400);
  proc.stdin.end();
  const out = (await new Response(proc.stdout).text()).trim().split("\n");
  const err = await new Response(proc.stderr).text();
  expect(out[0]).toBe("READY");
  const by = (id: number) => out.find((l) => l.split(" ")[1] === String(id));
  expect(by(1)).toBe('R 1 {"words":3,"top":[]}');
  expect(by(2)).toBe('R 2 {"ms":30,"nan":null}');
  expect(by(3)).toBe("E 3 invalid_args nope second line");
  expect(by(4)).toBe("E 4 internal ZeroDivisionError: division by zero");
  expect(by(5)).toBe("E 5 invalid_args text.stats: unknown argument nope");
  expect(by(6)).toBe("E 6 invalid_args text.stats: missing argument text");
  expect(by(7)).toBe("E 7 unknown text.missing: no such command");
  expect(by(8)).toBe("R 8 5.0");
  expect(by(9)).toStartWith("E 9 invalid_args geo.norm: p:");
  expect(out).toContain('V text.done {"ms":30}');
  expect(err).toContain("stdout is the log, not the protocol");
  expect(err).toContain("ZeroDivisionError"); // the traceback, in the log
  expect(await proc.exited).toBe(0); // stdin closed: it exits
}, 60_000);
