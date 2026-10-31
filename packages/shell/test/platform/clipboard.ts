import type { Harness } from "../harness-worker.ts";

// Restores the user's plain-text clipboard at the end.
export default async (t: Harness) => {
  const saved = (await t.call("clipboard", "readText")).value;
  try {
    t.check("writeText", (await t.call("clipboard", "writeText", { text: "héllo ✓" })).ok);
    t.check("readText roundtrip", (await t.call("clipboard", "readText")).value === "héllo ✓");
    t.check("has text/plain", (await t.call("clipboard", "has", { format: "text/plain" })).value === true);
    t.check("availableFormats has text/plain", (await t.call("clipboard", "availableFormats")).value.includes("text/plain"));
    t.check("writeHtml", (await t.call("clipboard", "writeHtml", { html: "<b>bold</b> text" })).ok);
    t.check("readHtml roundtrip", (await t.call("clipboard", "readHtml")).value?.includes("<b>bold</b>"));
    t.check("writeHtml also sets plain text", (await t.call("clipboard", "readText")).value?.includes("bold text"));
    const rtf = "{\\rtf1\\ansi hello rtf}";
    t.check("writeRtf", (await t.call("clipboard", "writeRtf", { rtf })).ok);
    t.check("readRtf roundtrip", (await t.call("clipboard", "readRtf")).value === rtf);
    // 1x1 red PNG
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    t.check("writeImage", (await t.call("clipboard", "writeImage", { bytes: png })).ok);
    const img = await t.call("clipboard", "readImage");
    t.check("readImage png", img.ok && img.value?.format === "png" && img.value.bytes.length > 20);
    t.check("has image/png", (await t.call("clipboard", "has", { format: "image/png" })).value === true);
    t.check("writeImage garbage → invalid_args", (await t.call("clipboard", "writeImage", { bytes: "!!" })).error?.code === "invalid_args");
    const tmp = `/tmp/sd-clip-${process.pid}.txt`;
    await Bun.write(tmp, "x");
    t.check("writePaths", (await t.call("clipboard", "writePaths", { paths: [tmp] })).ok);
    t.check("readPaths roundtrip", (await t.call("clipboard", "readPaths")).value?.[0]?.endsWith(`sd-clip-${process.pid}.txt`));
    t.check("clear", (await t.call("clipboard", "clear")).ok && (await t.call("clipboard", "readText")).value === null);
    t.check("page bridge: clipboard.writeText+readText", (await t.pageCall("clipboard", "writeText", { text: "from page" }) as any).ok && (await t.call("clipboard", "readText")).value === "from page");
  } finally {
    if (typeof saved === "string") await t.call("clipboard", "writeText", { text: saved });
  }
};
