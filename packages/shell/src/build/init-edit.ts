// `kitop init`'s edits of a project.

/** JSON for a file that already has some: its indentation and final newline stay, so a diff shows
 *  what changed and not the whole file. */
export function stringifyLike(raw: string, value: unknown): string {
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "\t";
  return JSON.stringify(value, null, indent) + (raw.endsWith("\n") || !raw ? "\n" : "");
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

