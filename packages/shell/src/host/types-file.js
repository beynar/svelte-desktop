import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Types for the `host` global: a one-line src/host.d.ts, written once (keep it in git). */
export function writeHostTypes(root) {
  const file = join(root, "src", "host.d.ts");
  if (existsSync(file) || !existsSync(join(root, "src"))) return;
  writeFileSync(file, "// The `host` global (kitop): typed for page and server code.\nimport '@kitop/shell/globals';\n");
}
