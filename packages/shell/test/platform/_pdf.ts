// Reads the PDFs WebKitGTK writes, for the print suites: no PDF tool in the image, and nothing past
// what these files use (page objects in the clear, Flate streams, Identity-H text with a ToUnicode map).
import { inflateSync } from "node:zlib";

export type Pdf = { pages: number; media: number[][]; text: string[]; clip: number[][] };

export function readPdf(bytes: Buffer | Uint8Array): Pdf | null {
  const file = Buffer.from(bytes).toString("latin1");
  if (!file.startsWith("%PDF-")) return null;
  const streams: string[] = [];
  const re = /stream\r?\n/g;
  for (let m; (m = re.exec(file)); ) {
    const end = file.indexOf("endstream", m.index);
    if (file.slice(m.index - 3, m.index) === "end") continue;
    try {
      streams.push(inflateSync(Buffer.from(file.slice(m.index + m[0].length, end), "latin1")).toString("latin1"));
    } catch {}
    re.lastIndex = end + 9;
  }
  const glyphs = new Map<number, string>();
  for (const cmap of streams.filter((s) => s.includes("begincmap"))) {
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const [, g, u] of block[1].matchAll(/<(\w+)>\s*<(\w+)>/g)) glyphs.set(parseInt(g, 16), String.fromCodePoint(parseInt(u, 16)));
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
      for (const [, from, to, u] of block[1].matchAll(/<(\w+)>\s*<(\w+)>\s*<(\w+)>/g))
        for (let g = parseInt(from, 16); g <= parseInt(to, 16); g++) glyphs.set(g, String.fromCodePoint(parseInt(u, 16) + g - parseInt(from, 16)));
  }
  const contents = streams.filter((s) => /^1 0 0 -1 0 [\d.]+ cm/.test(s));
  return {
    pages: (file.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
    media: [...file.matchAll(/\/MediaBox \[([^\]]*)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number)),
    text: contents.map((s) => [...s.matchAll(/<(\w+)> Tj/g)].map((m) => m[1].match(/.{4}/g)!.map((g) => glyphs.get(parseInt(g, 16)) ?? "?").join("")).join("")),
    // The printable area each page clips to: x, y from the top left, width, height.
    clip: contents.map((s) => (/q\n([\d. -]+) re\nW/.exec(s)?.[1] ?? "").split(" ").map(Number)),
  };
}
