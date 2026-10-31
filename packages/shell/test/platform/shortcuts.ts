// shortcuts.*: Carbon global hotkeys. Uses obscure all-modifier combos so the
// brief registrations cannot steal anything the user is doing.
import type { Harness } from "../harness-worker.ts";
import { CGFlags, pressKey } from "../objc.ts";

const HYPER = "Ctrl+Alt+Shift+Cmd";

export default async (t: Harness) => {
  await t.call("shortcuts", "unregisterAll");

  const reg = await t.call("shortcuts", "register", { accelerator: `${HYPER}+F19`, id: "hyper-f19" });
  t.check("register {accelerator,id} → {id}", reg.ok && reg.value.id === "hyper-f19", reg);
  const isReg = await t.call("shortcuts", "isRegistered", { id: "hyper-f19" });
  t.check("isRegistered → true", isReg.ok && isReg.value === true, isReg);

  // Accelerator grammar: generated ids default to the accelerator.
  for (const accel of [
    "CmdOrCtrl+Alt+Shift+Ctrl+K",
    "Option+Control+Shift+Command+Space",
    "Ctrl+Alt+Shift+Super+F5",
    "Ctrl+Alt+Shift+Cmd++",
    "Ctrl+Alt+Shift+Cmd+num5",
    "Ctrl+Alt+Shift+Cmd+Up",
    "Ctrl + Alt + Shift + Cmd + Esc",
    "F20",
  ]) {
    const r = await t.call("shortcuts", "register", { accelerator: accel });
    t.check(`register "${accel}" → id = accelerator`, r.ok && r.value.id === accel, r);
  }
  const accelAlias = await t.call("shortcuts", "register", { accel: `${HYPER}+J`, id: "alias" });
  t.check("`accel` argument alias", accelAlias.ok && accelAlias.value.id === "alias", accelAlias);

  for (const [label, args] of [
    ["duplicate id", { accelerator: `${HYPER}+L`, id: "hyper-f19" }],
    ["duplicate combo", { accelerator: "Cmd+Ctrl+Alt+Shift+F19", id: "other" }],
    ["unknown key", { accelerator: `${HYPER}+Nope` }],
    ["unknown modifier", { accelerator: "Hyper+K" }],
    ["modifier only", { accelerator: "Cmd+Shift" }],
    ["empty", { accelerator: "  " }],
    ["missing", {}],
  ] as const) {
    const r = await t.call("shortcuts", "register", args);
    t.check(`register ${label} → invalid_args`, r.error?.code === "invalid_args", r);
  }

  // Real key press → shortcutPressed/Released (synthetic events need Accessibility).
  const ax = await t.call("system", "checkPermission", { name: "accessibility" });
  if (ax.value?.status === "granted") {
    const pressed = t.waitEvent("shortcutPressed", 2000);
    const released = t.waitEvent("shortcutReleased", 2000);
    pressKey(0x50 /* kVK_F19 */, CGFlags.cmd | CGFlags.shift | CGFlags.ctrl | CGFlags.alt);
    const [p, r] = await Promise.all([pressed, released]);
    t.check("synthetic press → shortcutPressed/Released {id}", p?.id === "hyper-f19" && r?.id === "hyper-f19", { p, r });
  } else {
    t.skip("shortcutPressed/shortcutReleased on a real key press", "posting synthetic key events needs Accessibility trust for this process; press the key manually with --keep-open");
  }

  const viaPage = (await t.pageCall("shortcuts", "isRegistered", { id: "hyper-f19" })) as any;
  t.check("page bridge: shortcuts.isRegistered", viaPage.ok && viaPage.value === true, viaPage);

  const un = await t.call("shortcuts", "unregister", { id: "hyper-f19" });
  const isReg2 = await t.call("shortcuts", "isRegistered", { id: "hyper-f19" });
  t.check("unregister → {unregistered:true}, isRegistered false", un.value?.unregistered === true && isReg2.value === false, { un, isReg2 });
  const un2 = await t.call("shortcuts", "unregister", { id: "hyper-f19" });
  t.check("unregister unknown id → {unregistered:false}", un2.ok && un2.value.unregistered === false, un2);
  const reuse = await t.call("shortcuts", "register", { accelerator: `${HYPER}+F19`, id: "again" });
  t.check("combo is free again after unregister", reuse.ok, reuse);

  const all = await t.call("shortcuts", "unregisterAll");
  t.check("unregisterAll → count of removed registrations", all.ok && all.value.unregistered === 10, all);
  const all2 = await t.call("shortcuts", "unregister_all");
  t.check("unregister_all alias → 0 when empty", all2.ok && all2.value.unregistered === 0, all2);
  const noId = await t.call("shortcuts", "isRegistered", {});
  t.check("isRegistered missing id → invalid_args", noId.error?.code === "invalid_args", noId);
};
