import { expect, test } from "bun:test";
import { addDesktopPlugin, stringifyLike } from "./init-edit.ts";

test("desktop() goes next to sveltekit(), which keeps its options", () => {
  const head = "import { sveltekit } from '@sveltejs/kit/vite';\nimport { desktop } from '@kitop/shell/vite';\n";
  expect(addDesktopPlugin("import { sveltekit } from '@sveltejs/kit/vite';\nplugins: [sveltekit({ adapter: adapter() })],")).toBe(`${head}plugins: [sveltekit({ adapter: adapter() }), desktop()],`);
  // On lines of its own, with a parenthesis in a string and a plugin after it.
  expect(addDesktopPlugin("import { sveltekit } from '@sveltejs/kit/vite';\n\tplugins: [\n\t\tsveltekit({\n\t\t\tout: join('a', 'b)'),\n\t\t}),\n\t\tother()\n\t]")).toBe(`${head}\tplugins: [\n\t\tsveltekit({\n\t\t\tout: join('a', 'b)'),\n\t\t}),\n\t\tdesktop(),\n\t\tother()\n\t]`);
  expect(addDesktopPlugin("plugins: []")).toBeNull();
  expect(addDesktopPlugin("sveltekit({ unfinished")).toBeNull();
});

test("a rewritten package.json keeps its indentation and final newline", () => {
  const value = { name: "a", scripts: { dev: "x" } };
  expect(stringifyLike('{\n  "name": "a"\n}\n', value)).toBe('{\n  "name": "a",\n  "scripts": {\n    "dev": "x"\n  }\n}\n');
  expect(stringifyLike('{\n\t"name": "a"\n}', value)).toBe('{\n\t"name": "a",\n\t"scripts": {\n\t\t"dev": "x"\n\t}\n}');
  expect(stringifyLike('{"name":"a"}\n', { name: "a" })).toBe('{\n\t"name": "a"\n}\n');
});
