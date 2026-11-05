// `kitop init`'s edit of a Vite config.

/** The config without its `adapter: adapter(…)` option, whatever the call spans: the desktop plugin
 *  sets the adapter itself. A call whose end can't be found stays, rather than cutting the file. */
export function removeAdapterOption(src: string): string {
  const option = /\n?\s*adapter:\s*adapter\(/g;
  let out = "";
  let from = 0;
  for (let m = option.exec(src); m; m = option.exec(src)) {
    const end = closingParen(src, m.index + m[0].length);
    if (end < 0) break;
    const comma = /^\s*,/.exec(src.slice(end + 1));
    out += src.slice(from, m.index);
    from = end + 1 + (comma ? comma[0].length : 0);
    option.lastIndex = from;
  }
  return out + src.slice(from);
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
