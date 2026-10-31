// tray.*: NSStatusItem lifecycle, icons (every NATIVE_ICON_NAMES entry, SF
// Symbols, files), badge colors, menus, programmatic click → trayClick.
import { rmSync } from "node:fs";
import type { Harness } from "../harness-worker.ts";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export default async (t: Harness) => {
  // Keep the icon vocabulary in sync with the contract (index.ts imports the
  // gpuix bus, so read the list from source instead of importing it).
  const src = await Bun.file(new URL("../../../platform/src/index.ts", import.meta.url)).text();
  const names = [...(src.match(/NATIVE_ICON_NAMES = \[([\s\S]*?)\] as const/)?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  await t.call("tray", "remove");
  const unset = await t.call("tray", "isSet");
  t.check("tray.isSet false initially", unset.ok && unset.value === false, unset);
  const badFirst = await t.call("tray", "set", { title: "x", badgeColor: "nope" });
  const stillUnset = await t.call("tray", "isSet");
  t.check("invalid tray.set → invalid_args and creates nothing", badFirst.error?.code === "invalid_args" && stillUnset.value === false, { badFirst, stillUnset });

  const set = await t.call("tray", "set", { title: "SD", tooltip: "svelte-desktop harness" });
  t.check("tray.set {title,tooltip} → {set:true}", set.ok && set.value.set === true, set);
  const isSet = await t.call("tray", "isSet");
  const exists = await t.call("tray", "exists");
  t.check("tray.isSet / exists alias → true", isSet.value === true && exists.value === true, { isSet, exists });

  // y is top-left against the primary screen: negative when the active menu
  // bar is on a display above it. The menu bar animates a new item into place,
  // so wait until two readings agree before comparing with the click payload.
  let bounds = await t.call("tray", "getBounds");
  const readings = [bounds.value];
  for (let i = 0; i < 15; i++) {
    await t.sleep(200);
    const next = await t.call("tray", "getBounds");
    readings.push(next.value);
    const same = JSON.stringify(next.value) === JSON.stringify(bounds.value);
    bounds = next;
    if (same) break;
  }
  const r = bounds.value ?? {};
  t.check(
    "tray.getBounds → placed menu bar rect that settles",
    bounds.ok && r.width > 0 && r.height > 0 && r.height < 60 && JSON.stringify(readings.at(-1)) === JSON.stringify(readings.at(-2)),
    readings,
  );

  const click = t.waitEvent("trayClick", 2000);
  const pc = await t.call("tray", "performClick");
  const clicked = await click;
  t.check(
    "tray.performClick → trayClick {x,y,width,height} = button rect",
    pc.ok && clicked && ["x", "y", "width", "height"].every((k) => clicked[k] === r[k]),
    { pc, clicked },
  );

  // Every native icon name of the contract resolves (AppKit image or SF Symbol fallback).
  const failed: string[] = [];
  for (const n of names) {
    const res = await t.call("tray", "set", { imageName: n });
    if (!res.ok) failed.push(`${n}: ${res.error?.message}`);
  }
  t.check(`all ${names.length} NATIVE_ICON_NAMES resolve`, names.length > 50 && failed.length === 0, failed);
  const mixedCase = await t.call("tray", "set", { icon: { native: "LockLocked" } });
  t.check("icon {native} is case-insensitive", mixedCase.ok, mixedCase);
  for (const icon of [{ native: "star.fill" }, { symbol: "gearshape" }, "bolt.circle"]) {
    const res = await t.call("tray", "set", { icon });
    t.check(`SF Symbol icon ${JSON.stringify(icon)}`, res.ok, res);
  }
  const unknownIcon = await t.call("tray", "set", { imageName: "definitelynotanicon" });
  t.check("unknown native icon → invalid_args", unknownIcon.error?.code === "invalid_args", unknownIcon);
  for (const icon of [42, { nothing: true }, ["x"]]) {
    const res = await t.call("tray", "set", { icon });
    t.check(`malformed icon ${JSON.stringify(icon)} → invalid_args`, res.error?.code === "invalid_args", res);
  }

  // File icons.
  const png = `/tmp/sd-harness-tray-${process.pid}.png`;
  await Bun.write(png, Buffer.from(PNG_1x1, "base64"));
  const icns = "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericApplicationIcon.icns";
  for (const [label, args] of [
    ["imagePath png", { imagePath: png }],
    ["icon {path} icns (scaled)", { icon: { path: icns }, template: false }],
    ["icon path string", { icon: png }],
  ] as const) {
    const res = await t.call("tray", "set", args);
    t.check(`file icon: ${label}`, res.ok, res);
  }
  rmSync(png, { force: true });
  const noFile = await t.call("tray", "set", { imagePath: "/nonexistent/icon.png" });
  t.check("missing icon file → unavailable", noFile.error?.code === "unavailable", noFile);

  // Badge dot.
  for (const color of ["#ff3b30", "#0f08", "rgb(0, 122, 255)", "rgba(0 0 0 / 50%)", "orange"]) {
    const res = await t.call("tray", "set", { badgeColor: color });
    t.check(`badgeColor ${color}`, res.ok, res);
  }
  for (const color of ["notacolor", 42, "#12345"]) {
    const res = await t.call("tray", "set", { badgeColor: color });
    t.check(`badgeColor ${JSON.stringify(color)} → invalid_args`, res.error?.code === "invalid_args", res);
  }
  const clearBadge = await t.call("tray", "set", { badgeColor: null, imageName: null });
  t.check("badgeColor/imageName null clear", clearBadge.ok, clearBadge);

  // Menu.
  const items = [
    { id: "open", label: "Open" },
    { type: "separator" },
    { label: "More", type: "submenu", submenu: [{ id: "a", label: "A", checked: true }, { id: "b", label: "B", disabled: true }] },
    { id: "icon", label: "With icon", icon: { native: "share" } },
    { role: "copy" },
    { role: "separator" },
    { role: "quit" },
  ];
  const withMenu = await t.call("tray", "set", { menu: { items } });
  t.check("tray.set with menu (action, separator, submenu, checked, disabled, icon, roles)", withMenu.ok, withMenu);
  const pcMenu = await t.call("tray", "performClick");
  t.check("performClick with a menu → unsupported (would open it)", pcMenu.error?.code === "unsupported", pcMenu);
  const arrayMenu = await t.call("tray", "set", { menu: [{ id: "x", label: "X" }] });
  t.check("menu as a bare items array", arrayMenu.ok, arrayMenu);
  for (const [label, menu] of [
    ["unknown role", { items: [{ role: "teleport" }] }],
    ["empty submenu", { items: [{ type: "submenu", label: "Empty" }] }],
    ["no items", { nope: true }],
    ["bad menu icon", { items: [{ label: "x", icon: { native: "definitelynotanicon" } }] }],
  ] as const) {
    const res = await t.call("tray", "set", { menu });
    t.check(`menu ${label} → invalid_args`, res.error?.code === "invalid_args", res);
  }
  const noMenu = await t.call("tray", "set", { menu: null });
  const click2 = t.waitEvent("trayClick", 2000);
  const pc2 = await t.call("tray", "performClick");
  t.check("menu:null detaches; clicks emit trayClick again", noMenu.ok && pc2.ok && (await click2) !== null, { noMenu, pc2 });

  const viaPage = (await t.pageCall("tray", "isSet")) as any;
  t.check("page bridge: tray.isSet", viaPage.ok && viaPage.value === true, viaPage);
  const pageSet = (await t.pageCall("tray", "set", { title: "SD page" })) as any;
  t.check("page bridge: tray.set", pageSet.ok && pageSet.value.set === true, pageSet);

  const rm = await t.call("tray", "remove");
  const afterRm = await t.call("tray", "isSet");
  t.check("tray.remove → {removed:true}, isSet false", rm.value?.removed === true && afterRm.value === false, { rm, afterRm });
  const rm2 = await t.call("tray", "destroy");
  t.check("tray.destroy alias when unset → {removed:false}", rm2.ok && rm2.value.removed === false, rm2);
  const pcUnset = await t.call("tray", "performClick");
  const bUnset = await t.call("tray", "getBounds");
  t.check("performClick unset → unavailable, getBounds unset → null", pcUnset.error?.code === "unavailable" && bUnset.ok && bUnset.value === null, { pcUnset, bUnset });
  const created = await t.call("tray", "create", { imageName: "statusavailable" });
  await t.call("tray", "remove");
  t.check("tray.create alias", created.ok, created);

  t.skip("tray menu item click → menuAction {id}", "needs a human to open the status menu and pick an item");
  t.skip("physical mouse click on the status item", "needs a human (performClick covers the action path)");
};
