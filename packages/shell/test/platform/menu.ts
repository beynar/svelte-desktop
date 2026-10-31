import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const set = await t.call("menu", "setAppMenu", {
    menus: [
      { name: "Harness", items: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      { name: "File", items: [{ id: "new", label: "New", accelerator: "CmdOrCtrl+N" }, { id: "recent", label: "Recent", submenu: [{ id: "r1", label: "One" }] }] },
      { name: "Edit", items: [{ role: "editMenu" }] },
      { name: "View", items: [{ role: "viewMenu" }] },
      { name: "Window", items: [{ role: "windowMenu" }] },
    ],
  });
  t.check("setAppMenu", set.ok, set);
  const items = (await t.call("menu", "items")).value;
  t.check("items snapshot", items.length === 5 && items[1].text === "File", items.map((i: any) => i.text));
  const g = (await t.call("menu", "get", { id: "new" })).value;
  t.check("get item", g?.id === "new" && g.text === "New" && g.enabled === true, g);
  t.check("get nested", (await t.call("menu", "get", { id: "r1" })).value?.text === "One");
  t.check("get unknown → null", (await t.call("menu", "get", { id: "zzz" })).value === null);
  t.check("update", (await t.call("menu", "update", { id: "new", text: "New…", enabled: false, checked: true, accelerator: "Cmd+Shift+N" })).ok);
  const u = (await t.call("menu", "get", { id: "new" })).value;
  t.check("update applied", u.text === "New…" && u.enabled === false && u.checked === true, u);
  t.check("update unknown → invalid_args", (await t.call("menu", "update", { id: "zzz", text: "x" })).error?.code === "invalid_args");
  t.check("insert submenu before Window", (await t.call("menu", "insert", { name: "Tools", items: [{ id: "t1", label: "Tool" }] })).ok);
  const after = (await t.call("menu", "items")).value.map((i: any) => i.text);
  t.check("insert position", after.indexOf("Tools") === after.indexOf("Window") - 1, after);
  t.check("insert replaces same name", (await t.call("menu", "insert", { name: "Tools", items: [] })).ok && (await t.call("menu", "items")).value.filter((i: any) => i.text === "Tools").length === 1);
  t.check("remove", (await t.call("menu", "remove", { name: "Tools" })).value?.removed === true);
  t.check("remove unknown", (await t.call("menu", "remove", { name: "Tools" })).value?.removed === false);
  t.check("bad role → invalid_args", (await t.call("menu", "setAppMenu", { menus: [{ name: "X", items: [{ role: "teleport" }] }] })).error?.code === "invalid_args");
  t.check("native icon", (await t.call("menu", "insert", { name: "Icons", items: [{ id: "i1", label: "Add", icon: { native: "add" } }] })).ok);
  t.check("setDockMenu", (await t.call("menu", "setDockMenu", { items: [{ id: "dock-new", label: "New Window" }] })).ok);
  t.check("page bridge: menu.items", (await t.pageCall("menu", "items") as any).ok);
  t.skip("popup / clicking an item (menuAction)", "needs a human click; popup tracks until dismissed");
};
