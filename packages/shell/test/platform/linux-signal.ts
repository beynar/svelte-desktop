// SIGTERM / SIGINT while parked in gtk_main: the glib unix signal source emits
// {"type":"signal"} and quits the loop; the harness then exits 0 (a process
// killed by the signal would exit 143/130). Driven by run-platform-linux.sh.
import { JSCallback, FFIType, CString, type Pointer } from "bun:ffi";
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  // Take over the raw event stream (the suite ends with the process anyway).
  const sink = new JSCallback((p: Pointer) => {
    const s = new CString(p).toString();
    t.native.shell_free(p);
    if (JSON.parse(s).type === "signal") console.log(s);
  }, { args: [FFIType.ptr], returns: FFIType.void, threadsafe: true });
  t.native.shell_set_event_sink(sink.ptr!);
  const sig = `SIG${process.env.SIG ?? "TERM"}` as "SIGTERM" | "SIGINT";
  await t.sleep(200);
  process.kill(process.pid, sig);
  await t.sleep(30_000); // the loop stops; harness.ts exits before this resolves
};
