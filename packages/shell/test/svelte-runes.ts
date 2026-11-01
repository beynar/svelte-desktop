// bun test preload: compiles `.svelte.ts` modules (runes) with Svelte, so their classes run in tests.
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

plugin({
  name: "svelte-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(js, { filename: path, generate: "client" }).js.code, loader: "js" };
    });
  },
});
