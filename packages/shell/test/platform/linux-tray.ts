// tray.* through libayatana-appindicator3 (StatusNotifierItem). The test session
// has no SNI host, so appindicator keeps the item registered without showing it;
// the API state, menus, icons and the click path are what's verified here.
import { rmSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export default async (t: Harness) => {
  const src = await Bun.file(new URL("../../src/platform/index.ts", import.meta.url)).text();
  const names = [...(src.match(/NATIVE_ICON_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  await t.call("tray", "remove");
  t.check("tray.isSet false initially", (await t.call("tray", "isSet")).value === false);
  const badFirst = await t.call("tray", "set", { title: "x", badgeColor: "nope" });
  t.check("invalid tray.set → invalid_args and creates nothing", badFirst.error?.code === "invalid_args" && (await t.call("tray", "isSet")).value === false, badFirst);
  const set = await t.call("tray", "set", { title: "SD", tooltip: "svelte-desktop harness" });
  t.check("tray.set {title,tooltip} → {set:true}", set.ok && set.value.set === true, set);
  t.check("tray.isSet / exists alias → true", (await t.call("tray", "isSet")).value === true && (await t.call("tray", "exists")).value === true);
  t.check("tray.getBounds → null (SNI doesn't expose the icon position)", (await t.call("tray", "getBounds")).value === null);
  const click = t.waitEvent("trayClick", 2000);
  const pc = await t.call("tray", "performClick");
  t.check("performClick → trayClick", pc.ok && pc.value.clicked === true && (await click) !== null, pc);
  const failed: string[] = [];
  for (const n of names) {
    const res = await t.call("tray", "set", { imageName: n });
    if (!res.ok) failed.push(`${n}: ${res.error?.message}`);
  }
  t.check(`all ${names.length} NATIVE_ICON_NAMES map to theme icons`, names.length > 50 && failed.length === 0, failed);
  t.check("icon {native} is case-insensitive", (await t.call("tray", "set", { icon: { native: "LockLocked" } })).ok);
  t.check("freedesktop icon name string", (await t.call("tray", "set", { icon: "mail-unread" })).ok);
  t.check("unknown native icon → invalid_args", (await t.call("tray", "set", { imageName: "definitelynotanicon" })).error?.code === "invalid_args");
  for (const icon of [42, { nothing: true }, ["x"]]) t.check(`malformed icon ${JSON.stringify(icon)} → invalid_args`, (await t.call("tray", "set", { icon })).error?.code === "invalid_args");
  const png = `/tmp/sd-harness-tray-${process.pid}.png`;
  await Bun.write(png, Buffer.from(PNG_1x1, "base64"));
  t.check("file icon: imagePath png", (await t.call("tray", "set", { imagePath: png })).ok);
  t.check("file icon: icon {path}", (await t.call("tray", "set", { icon: { path: png } })).ok);
  rmSync(png, { force: true });
  t.check("missing icon file → unavailable", (await t.call("tray", "set", { imagePath: "/nonexistent/icon.png" })).error?.code === "unavailable");
  for (const color of ["#ff3b30", "rgb(0, 122, 255)", "orange"]) t.check(`badgeColor ${color} accepted`, (await t.call("tray", "set", { badgeColor: color })).ok);
  t.check("badgeColor notacolor → invalid_args", (await t.call("tray", "set", { badgeColor: "notacolor" })).error?.code === "invalid_args");
  const items = [
    { id: "open", label: "Open" }, { type: "separator" },
    { label: "More", type: "submenu", submenu: [{ id: "a", label: "A", checked: true }, { id: "b", label: "B", disabled: true }] },
    { id: "icon", label: "With icon", icon: { native: "share" } }, { role: "copy" }, { role: "separator" }, { role: "quit" },
  ];
  t.check("tray.set with menu (action, separator, submenu, checked, disabled, icon, roles)", (await t.call("tray", "set", { menu: { items } })).ok);
  t.check("performClick with a menu → unsupported (would open it)", (await t.call("tray", "performClick")).error?.code === "unsupported");
  t.check("menu as a bare items array", (await t.call("tray", "set", { menu: [{ id: "x", label: "X" }] })).ok);
  for (const [label, menu] of [["unknown role", { items: [{ role: "teleport" }] }], ["empty submenu", { items: [{ type: "submenu", label: "Empty" }] }], ["no items", { nope: true }], ["bad menu icon", { items: [{ label: "x", icon: { native: "definitelynotanicon" } }] }]] as const)
    t.check(`menu ${label} → invalid_args`, (await t.call("tray", "set", { menu })).error?.code === "invalid_args");
  const noMenu = await t.call("tray", "set", { menu: null });
  const click2 = t.waitEvent("trayClick", 2000);
  const pc2 = await t.call("tray", "performClick");
  t.check("menu:null detaches; clicks emit trayClick again", noMenu.ok && pc2.ok && (await click2) !== null, { noMenu, pc2 });
  t.check("page bridge: tray.isSet", ((await t.pageCall("tray", "isSet")) as any).value === true);
  const rm = await t.call("tray", "remove");
  t.check("tray.remove → {removed:true}, isSet false", rm.value?.removed === true && (await t.call("tray", "isSet")).value === false, rm);
  t.check("tray.destroy alias when unset → {removed:false}", (await t.call("tray", "destroy")).value?.removed === false);
  t.check("performClick unset → unavailable, getBounds unset → null", (await t.call("tray", "performClick")).error?.code === "unavailable" && (await t.call("tray", "getBounds")).value === null);
  t.check("tray.create alias", (await t.call("tray", "create", { imageName: "statusavailable" })).ok);
  await t.call("tray", "remove");
  t.skip("tray menu item click → menuAction {id}", "needs an SNI host (panel) and a human");
};
