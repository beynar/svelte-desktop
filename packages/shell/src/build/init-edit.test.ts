import { expect, test } from "bun:test";
import { removeAdapterOption } from "./init-edit.ts";

test("the adapter option goes, whatever its call looks like; the rest stays", () => {
  expect(removeAdapterOption("desktop({\n  adapter: adapter(),\n  x: 1,\n})")).toBe("desktop({\n  x: 1,\n})");
  expect(removeAdapterOption("desktop({ adapter: adapter(), x: 1 })")).toBe("desktop({ x: 1 })");
  // Over several lines, nested calls, and a parenthesis in a string.
  expect(removeAdapterOption("desktop({\n  adapter: adapter({\n    out: join('a', 'b)'),\n  }),\n  x: 1,\n})")).toBe("desktop({\n  x: 1,\n})");
  expect(removeAdapterOption("desktop({\n  x: 1,\n  adapter: adapter()\n})")).toBe("desktop({\n  x: 1,\n})");
  expect(removeAdapterOption("desktop({ x: 1 })")).toBe("desktop({ x: 1 })");
});

test("a call that doesn't end: nothing is cut", () => {
  const broken = "desktop({ adapter: adapter({ out: 'a' }";
  expect(removeAdapterOption(broken)).toBe(broken);
});
