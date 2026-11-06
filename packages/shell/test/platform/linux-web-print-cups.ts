// getPrinters and silent printing with a printer to talk to: GTK's CUPS backend, the real one, against
// a small IPP server here (CUPS_SERVER, set by run-platform-linux.sh; the image has no cupsd). What a
// job is checked against is what reached the server.
import type { Harness } from "../harness-worker.ts";
import { readPdf } from "./_pdf.ts";

const PORT = 8631;

function attr(tag: number, name: string, value: string | Buffer) {
  const v = typeof value === "string" ? Buffer.from(value) : value;
  const out = Buffer.alloc(1 + 2 + name.length + 2 + v.length);
  out[0] = tag;
  out.writeUInt16BE(name.length, 1);
  out.write(name, 3, "latin1");
  out.writeUInt16BE(v.length, 3 + name.length);
  v.copy(out, 5 + name.length);
  return out;
}
const int = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
// printer-type's default bit is how GTK learns the default printer.
const printerGroup = (name: string) =>
  Buffer.concat([
    Buffer.from([0x04]),
    attr(0x42, "printer-name", name),
    attr(0x45, "printer-uri-supported", `ipp://127.0.0.1:${PORT}/printers/${name}`),
    attr(0x23, "printer-state", int(3)),
    attr(0x44, "printer-state-reasons", "none"),
    attr(0x22, "printer-is-accepting-jobs", Buffer.from([1])),
    attr(0x21, "queued-job-count", int(0)),
    attr(0x23, "printer-type", int(0x1000 | 0x4 | (name === "kitop-second" ? 0x20000 : 0))),
    attr(0x41, "printer-info", name),
    attr(0x41, "printer-location", "here"),
    attr(0x41, "printer-make-and-model", "kitop test printer"),
    attr(0x49, "document-format-supported", "application/pdf"),
  ]);

export default async (t: Harness) => {
  const jobs: { uri: string; body: Buffer; attrs: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(req) {
      if (req.method !== "POST") return new Response("no", { status: 404 });
      const body = Buffer.from(await req.arrayBuffer());
      const op = body.readUInt16BE(2);
      const groups: Buffer[] = [Buffer.from([0x01]), attr(0x47, "attributes-charset", "utf-8"), attr(0x48, "attributes-natural-language", "en")];
      if (op === 0x4002) groups.push(printerGroup("kitop-first"), printerGroup("kitop-second"));
      if (op === 0x0002) {
        const doc = body.indexOf("%PDF");
        jobs.push({ uri: new URL(req.url).pathname, attrs: body.subarray(0, doc < 0 ? body.length : doc).toString("latin1"), body: body.subarray(doc < 0 ? body.length : doc) });
        groups.push(Buffer.from([0x02]), attr(0x21, "job-id", int(jobs.length)), attr(0x23, "job-state", int(9)), attr(0x44, "job-state-reasons", "none"));
      }
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(body.readUInt32BE(4), 4);
      return new Response(Buffer.concat([header, ...groups, Buffer.from([0x03])]), { headers: { "content-type": "application/ipp" } });
    },
  });
  const wv = (op: string, args: Record<string, unknown> = {}) => t.call("webview", op, args);
  await t.page(`document.body.innerHTML = ['FIRSTPAGE', 'SECONDPAGE', 'THIRDPAGE'].map((w, i) => '<p style="' + (i ? 'break-before: page' : '') + '">' + w + '</p>').join(''); return 1`);

  const printers = await wv("getPrinters");
  t.check("getPrinters: what the print system has, no more", JSON.stringify([...(printers.value ?? [])].sort()) === '["kitop-first","kitop-second"]', printers);

  let at = (t.events.get("printFinished") ?? []).length;
  const named = await wv("print", { silent: true, printer: "kitop-first" });
  t.check("silent, to a named printer → {success}", named.value?.success === true && !("path" in named.value), named);
  const job = jobs[0];
  const doc = job && readPdf(job.body);
  t.check("the job reached that printer, as a PDF of the page", job?.uri.includes("kitop-first") || job?.attrs.includes("printers/kitop-first"), job && { uri: job.uri, attrs: job.attrs });
  t.check("…with the page in it", doc?.pages === 3 && doc.text[0].includes("FIRSTPAGE"), doc);
  await t.sleep(50);
  t.check("printFinished {success: true}", (t.events.get("printFinished") ?? [])[at]?.success === true);

  const lastJob = (n: number) => (jobs.length === n + 1 ? jobs[n] : undefined);
  let n = jobs.length;
  const dflt = await wv("print", { silent: true });
  t.check("silent, no name: the default printer", dflt.ok && lastJob(n)?.attrs.includes("printers/kitop-second"), { dflt, attrs: lastJob(n)?.attrs });

  n = jobs.length;
  const copies = await wv("print", { silent: true, printer: "kitop-first", copies: 3 });
  const copiesDoc = lastJob(n) && readPdf(lastJob(n)!.body);
  t.check("copies reach the printer, or are in the document", copies.ok && (lastJob(n)?.attrs.includes("copies") || copiesDoc?.pages === 9), { copies, attrs: lastJob(n)?.attrs, pages: copiesDoc?.pages });

  n = jobs.length;
  const range = await wv("print", { silent: true, printer: "kitop-first", pageRanges: [{ from: 2, to: 3 }] });
  const rangeDoc = lastJob(n) && readPdf(lastJob(n)!.body);
  t.check("a page range", range.ok && rangeDoc?.pages === 2 && rangeDoc.text[0].includes("SECONDPAGE"), { range, rangeDoc, attrs: lastJob(n)?.attrs });

  n = jobs.length;
  const paper = await wv("print", { silent: true, printer: "kitop-first", paperSize: { width: 300, height: 400 }, orientation: "landscape" });
  const paperDoc = lastJob(n) && readPdf(lastJob(n)!.body);
  t.check("paper and orientation", paper.ok && paperDoc?.media[0][2] === 400 && paperDoc.media[0][3] === 300, { paper, media: paperDoc?.media[0] });

  n = jobs.length;
  t.check("a printer it doesn't have → invalid_args", (await wv("print", { silent: true, printer: "kitop-third" })).error?.code === "invalid_args" && jobs.length === n);
  server.stop(true);
};
