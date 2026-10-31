// dialog.* on GTK: real GtkMessageDialog / GtkFileChooserNative, answered through
// the internal dialog._test hook (no synthetic input needed).
import type { Harness } from "../harness-worker.ts";

const state = async (t: Harness) => (await t.call("dialog", "_test", { action: "state" })).value;
async function waitFor(t: Harness, pred: (s: any) => boolean) {
  for (let i = 0; i < 40; i++) {
    const s = await state(t);
    if (pred(s)) return s;
    await t.sleep(50);
  }
  return state(t);
}

export default async (t: Harness) => {
  const box = t.call("dialog", "showMessageBox", { type: "warning", message: "Delete all notes?", detail: "This cannot be undone.", buttons: ["Delete", "Keep", "Cancel"] });
  const open = await waitFor(t, (s) => !!s?.message);
  t.check("message box is up with message + detail, transient for the window", open.message?.labels.includes("Delete all notes?") && open.message.labels.includes("This cannot be undone.") && open.message.transient === true, open);
  await t.call("dialog", "_test", { action: "respond", response: 1 });
  const r = await box;
  t.check("showMessageBox resolves {response:1, canceled:false}", r.ok && r.value.response === 1 && r.value.canceled === false, r);
  const box2 = t.call("dialog", "showMessageBox", { message: "Again", buttons: ["OK", "Cancel"] });
  await waitFor(t, (s) => !!s?.message);
  await t.call("dialog", "_test", { action: "respond", response: -4 }); // GTK_RESPONSE_DELETE_EVENT (Escape / close)
  const r2 = await box2;
  t.check("Escape/close → cancel button, canceled:true", r2.value?.response === 1 && r2.value.canceled === true, r2);
  const confirm = t.call("dialog", "showConfirm", { message: "Sure?" });
  await waitFor(t, (s) => !!s?.message);
  await t.call("dialog", "_test", { action: "respond", response: 0 });
  t.check("showConfirm → true on the first button", (await confirm).value === true);
  const pageBox = t.pageCall("dialog", "showMessageBox", { message: "From the page" });
  await waitFor(t, (s) => !!s?.message);
  await t.call("dialog", "_test", { action: "respond", response: 0 });
  t.check("page bridge: dialog.showMessageBox", ((await pageBox) as any).value?.response === 0);

  const od = t.call("dialog", "showOpenDialog", { title: "Pick files", multiple: true, filters: [{ name: "Text", extensions: ["txt", "md"] }] });
  const fo = await waitFor(t, (s) => !!s?.file);
  t.check("open dialog is up (GtkFileChooserNative, OPEN, multiple)", fo.file?.title === "Pick files" && fo.file.action === 0 && fo.file.multiple === true, fo);
  t.check("a second file dialog while one is open → unavailable", (await t.call("dialog", "showSaveDialog", {})).error?.code === "unavailable");
  await t.call("dialog", "_test", { action: "cancel" });
  const odr = await od;
  t.check("open dialog canceled → {canceled:true, paths:[]}", odr.ok && odr.value.canceled === true && odr.value.paths.length === 0, odr);
  const dirs = t.call("dialog", "showOpenDialog", { directories: true, files: false });
  t.check("directories only → SELECT_FOLDER", (await waitFor(t, (s) => !!s?.file)).file?.action === 2);
  await t.call("dialog", "_test", { action: "cancel" });
  await dirs;
  const sd = t.call("dialog", "showSaveDialog", { defaultPath: "/tmp/notes.md" });
  t.check("save dialog is up (SAVE)", (await waitFor(t, (s) => !!s?.file)).file?.action === 1);
  await t.call("dialog", "_test", { action: "cancel" });
  const sdr = await sd;
  t.check("save dialog canceled → {canceled:true, path:null}", sdr.ok && sdr.value.canceled === true && sdr.value.path === null, sdr);
  t.skip("choosing a file in the chooser", "GtkFileChooserNative has no programmatic accept; needs a human (the cancel path is exercised)");
};
