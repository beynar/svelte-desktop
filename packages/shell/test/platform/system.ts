// system.*: info, keyboard layout, accent color, accessibility, permissions.
import type { Harness } from "../harness-worker.ts";
import { postDistributed } from "../objc.ts";

const STATUSES = ["granted", "denied", "notDetermined", "unknown"];

export default async (t: Harness) => {
  const info = await t.call("system", "info");
  const v = info.value ?? {};
  t.check(
    "system.info shape",
    info.ok && v.os === "macos" && v.family === "unix" && ["aarch64", "x86_64"].includes(v.arch) && typeof v.keyboardLayout === "string" && v.keyboardLayout.length > 0,
    info,
  );

  const kb = await t.call("system", "getKeyboardLayout");
  t.check("system.getKeyboardLayout {name,id} matches info", kb.ok && kb.value.name === v.keyboardLayout && typeof kb.value.id === "string" && kb.value.id.length > 0, kb);

  const accent = await t.call("system", "getAccentColor");
  const ch = accent.value ?? {};
  t.check("system.getAccentColor sRGB channels in [0,1]", accent.ok && ["r", "g", "b", "a"].every((k) => typeof ch[k] === "number" && ch[k] >= 0 && ch[k] <= 1), accent);

  const a11y = await t.call("system", "getAccessibility");
  t.check(
    "system.getAccessibility four booleans",
    a11y.ok && ["reduceMotion", "highContrast", "differentiateWithoutColor", "reduceTransparency"].every((k) => typeof a11y.value[k] === "boolean"),
    a11y,
  );

  // checkPermission never prompts: run all of them.
  let unbundled = false;
  for (const name of ["accessibility", "screenRecording", "fullDiskAccess", "camera", "microphone", "notifications"]) {
    const r = await t.call("system", "checkPermission", { name });
    if (name === "notifications" && !r.ok) {
      unbundled = r.error?.code === "unavailable";
      t.check("system.checkPermission notifications → unavailable when unbundled", unbundled && /bundle/i.test(r.error!.message), r);
    } else {
      t.check(`system.checkPermission ${name} → status`, r.ok && STATUSES.includes(r.value.status), r);
    }
  }
  const bad = await t.call("system", "checkPermission", { name: "telepathy" });
  t.check("system.checkPermission unknown name → invalid_args", bad.error?.code === "invalid_args", bad);
  const missing = await t.call("system", "checkPermission");
  t.check("system.checkPermission missing name → invalid_args", missing.error?.code === "invalid_args", missing);

  const fda = await t.call("system", "requestPermission", { name: "fullDiskAccess" });
  t.check("system.requestPermission fullDiskAccess → unsupported", fda.error?.code === "unsupported", fda);
  const badReq = await t.call("system", "requestPermission", { name: "telepathy" });
  t.check("system.requestPermission unknown name → invalid_args", badReq.error?.code === "invalid_args", badReq);
  if (unbundled) {
    // No Info.plist usage description → refused before AVFoundation is touched (no prompt, no crash).
    for (const name of ["camera", "microphone"]) {
      const r = await t.call("system", "requestPermission", { name });
      t.check(`system.requestPermission ${name} → unavailable without usage description`, r.error?.code === "unavailable" && /UsageDescription/.test(r.error.message), r);
    }
    const n = await t.call("system", "requestPermission", { name: "notifications" });
    t.check("system.requestPermission notifications → unavailable when unbundled", n.error?.code === "unavailable", n);
  } else {
    t.skip("system.requestPermission camera/microphone/notifications", "bundled run: would show a permission prompt");
  }
  t.skip("system.requestPermission accessibility/screenRecording", "shows a system prompt; needs a human");

  const pane = await t.call("system", "openSettings", { pane: "nowhere" });
  t.check("system.openSettings unknown pane → invalid_args", pane.error?.code === "invalid_args", pane);
  t.skip("system.openSettings real pane", "opens System Settings on the user's screen");

  // keyboardLayoutChanged: post the real (harmless) distributed notification.
  const ev = t.waitEvent("keyboardLayoutChanged", 3000);
  postDistributed("com.apple.Carbon.TISNotifySelectedKeyboardInputSourceChanged");
  const got = await ev;
  t.check("keyboardLayoutChanged emitted with {} on input source change", got !== null && Object.keys(got).length === 0, got);

  const viaPage = (await t.pageCall("system", "getKeyboardLayout")) as any;
  t.check("page bridge: system.getKeyboardLayout", viaPage.ok && viaPage.value.name === v.keyboardLayout, viaPage);

  const unk = await t.call("system", "getHostName");
  t.check("system unknown op → unsupported", unk.error?.code === "unsupported", unk);
};
