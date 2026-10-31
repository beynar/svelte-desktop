import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  t.skip("showMessageBox / showConfirm / showOpenDialog / showSaveDialog", "modal UI waits for a human answer (exercised manually in examples/notes)");
};
