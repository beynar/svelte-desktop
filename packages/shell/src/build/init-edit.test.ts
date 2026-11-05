import { expect, test } from "bun:test";
import { removeAdapterOption, stringifyLike } from "./init-edit.ts";

test("a rewritten package.json keeps its indentation and final newline", () => {
  const value = { name: "a", scripts: { dev: "x" } };
  expect(stringifyLike('{\n  "name": "a"\n}\n', value)).toBe('{\n  "name": "a",\n  "scripts": {\n    "dev": "x"\n  }\n}\n');
  expect(stringifyLike('{\n\t"name": "a"\n}', value)).toBe('{\n\t"name": "a",\n\t"scripts": {\n\t\t"dev": "x"\n\t}\n}');
  expect(stringifyLike('{"name":"a"}\n', { name: "a" })).toBe('{\n\t"name": "a"\n}\n');
});

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
