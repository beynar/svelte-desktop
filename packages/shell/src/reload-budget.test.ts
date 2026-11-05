// native/portable/reload_budget.hpp, what all three backends decide with: compiled and run here.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cxx = Bun.which("c++") ?? Bun.which("clang++") ?? Bun.which("g++");

const PROGRAM = `
#include <iostream>
#include "reload_budget.hpp"
int main() {
  sd::ReloadBudget b;
  for (double t : {0.0, 1.0, 2.0, 3.0, 4.0, 299.0, 301.0, 302.0, 303.0, 304.0}) std::cout << b.next(t) << " ";
  std::cout << "\\n";
  for (const char *u : {"http://127.0.0.1:5000/notes?id=1&x=a b#top", "http://127.0.0.1:5000", "http://127.0.0.1:50001/x", "https://example.com/",
                        "http://127.0.0.1:5000/__desktop/page-crashed?to=/"})
    std::cout << "[" << sd::crashed_page_url("http://127.0.0.1:5000", u) << "]\\n";
  std::cout << "[" << sd::crashed_page_url("", "http://127.0.0.1:5000/") << "]\\n";
}
`;

test.skipIf(!cxx)("delays grow, stop at the limit, and start over once the crashes are old", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-budget-"));
  writeFileSync(join(dir, "main.cc"), PROGRAM);
  const include = resolve(import.meta.dir, "../native/portable");
  const built = Bun.spawnSync([cxx!, "-std=c++17", `-I${include}`, join(dir, "main.cc"), "-o", join(dir, "main")], { stderr: "pipe" });
  expect(built.stderr.toString()).toBe("");
  const lines = Bun.spawnSync([join(dir, "main")]).stdout.toString().trim().split("\n");

  // Crashes at 0, 1, 2 reload; 3, 4 and 299 don't: three reloads are still within 5 minutes. At 301
  // only the one at 2 still counts, and from there the budget is used up again.
  expect(lines[0]!.trim().split(" ").map(Number)).toEqual([100, 1000, 4000, -1, -1, -1, 1000, 1000, 4000, -1]);
  expect(lines.slice(1)).toEqual([
    "[http://127.0.0.1:5000/__desktop/page-crashed?to=/notes%3Fid%3D1%26x%3Da%20b%23top]",
    "[http://127.0.0.1:5000/__desktop/page-crashed?to=/]",
    "[]", // another port: not this server
    "[]", // another site
    "[]", // that page itself crashing: nothing left to try
    "[]", // no server yet
  ]);
}, 120_000);
