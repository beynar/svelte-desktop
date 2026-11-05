import { expect, test } from "bun:test";
import { stringifyLike } from "./init-edit.ts";

test("a rewritten package.json keeps its indentation and final newline", () => {
  const value = { name: "a", scripts: { dev: "x" } };
  expect(stringifyLike('{\n  "name": "a"\n}\n', value)).toBe('{\n  "name": "a",\n  "scripts": {\n    "dev": "x"\n  }\n}\n');
  expect(stringifyLike('{\n\t"name": "a"\n}', value)).toBe('{\n\t"name": "a",\n\t"scripts": {\n\t\t"dev": "x"\n\t}\n}');
  expect(stringifyLike('{"name":"a"}\n', { name: "a" })).toBe('{\n\t"name": "a"\n}\n');
});
