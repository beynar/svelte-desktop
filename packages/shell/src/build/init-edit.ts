// `kitop init`'s edits of a project.

/** JSON for a file that already has some: its indentation and final newline stay, so a diff shows
 *  what changed and not the whole file. */
export function stringifyLike(raw: string, value: unknown): string {
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "\t";
  return JSON.stringify(value, null, indent) + (raw.endsWith("\n") || !raw ? "\n" : "");
}

/** Where the parenthesis opened just before `at` closes, past strings. -1 if it doesn't. */
function closingParen(src: string, at: number): number {
  let depth = 1;
  let quote = "";
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The config with `desktop()` next to `sveltekit(…)`, and its import. Null if it can't tell where. */
export function addDesktopPlugin(src: string): string | null {
  const call = /\bsveltekit\(/.exec(src);
  if (!call) return null;
  const end = closingParen(src, call.index + call[0].length);
  if (end < 0) return null;
  const lineStart = src.lastIndexOf("\n", call.index) + 1;
  const before = src.slice(lineStart, call.index);
  const plugin = before.trim() === "" ? `,\n${before}desktop()` : ", desktop()";
  const out = src.slice(0, end + 1) + plugin + src.slice(end + 1);
  const line = "import { desktop } from '@kitop/shell/vite';";
  const kit = /import\s*\{\s*sveltekit\s*\}\s*from\s*['"]@sveltejs\/kit\/vite['"];?/.exec(out);
  return kit ? out.slice(0, kit.index + kit[0].length) + "\n" + line + out.slice(kit.index + kit[0].length) : `${line}\n${out}`;
}

/** A first test, so `test:desktop` has something to run in a project with no `tests` folder. */
export const STARTER_TEST = `import { afterAll, beforeAll, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

let app: AppHandle;
beforeAll(async () => (app = await launch()));
afterAll(() => app?.close());

test('the built app opens and shows a page', async () => {
	await app.waitFor('body *');
});
`;

