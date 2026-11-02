// bun test preload: compiles `.svelte.ts` modules (runes) with Svelte, so their classes run in tests.
// Svelte is loaded on the first such module only (suites without one don't need it installed).
import { plugin } from "bun";

plugin({
  name: "svelte-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const { compileModule } = await import("svelte/compiler");
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(js, { filename: path, generate: "client" }).js.code, loader: "js" };
    });
  },
});
