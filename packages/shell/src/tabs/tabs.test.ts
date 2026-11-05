// TabGroup on a plain store, and its callbacks.
import { expect, test } from "bun:test";
import { TabGroup, decodedPath, routeMatcher, type TabLike, type TabsOptions } from "./tabs.svelte.ts";

type Board = TabLike & { board: string };
function group(options: TabsOptions<Board> = {}, items: Board[] = [{ id: "a", title: "A", board: "a" }, { id: "b", title: "B", board: "b" }]) {
  const store = { items, active: undefined as string | undefined };
  return { store, tabs: new TabGroup<Board>(() => options, store) };
}

test("the tabs are yours: every change lands on your array, the active id too", () => {
  const { store, tabs } = group({ newTab: () => ({ title: "New", board: "n" }) });
  expect(store.active).toBe("a");
  const added = tabs.new()!;
  expect(store.items.map((t) => t.title)).toEqual(["A", "B", "New"]);
  expect(store.active).toBe(added.id);
  tabs.move("a", 2);
  expect(store.items.map((t) => t.id)).toEqual(["b", added.id, "a"]);
  tabs.update("b", { title: "Bee" });
  expect(store.items[0]).toEqual({ id: "b", title: "Bee", board: "b" });
  tabs.close(added.id);
  expect(store.items.map((t) => t.id)).toEqual(["b", "a"]);
  expect(store.active).toBe("a");
  tabs.reopen();
  expect(store.items.map((t) => t.title)).toEqual(["Bee", "New", "A"]);
});

test("your array changing is what the group sees", () => {
  const { store, tabs } = group();
  store.items = [...store.items, { id: "c", title: "C", board: "c" }];
  expect(tabs.items.map((t) => t.id)).toEqual(["a", "b", "c"]);
  store.active = "c";
  expect(tabs.active?.title).toBe("C");
});

test("callbacks: onclose can keep a tab, onactivate and onmove follow", () => {
  const seen: string[] = [];
  const { store, tabs } = group({
    onclose: (t) => t.id !== "b",
    onactivate: (t) => void seen.push(`activate ${t.id}`),
    onmove: (t, i) => void seen.push(`move ${t.id} ${i}`),
  });
  tabs.close("b");
  expect(store.items.map((t) => t.id)).toEqual(["a", "b"]); // kept
  tabs.activate("b");
  tabs.activate("b"); // already active: no second call
  tabs.move("b", 0);
  tabs.close("a");
  expect(store.items.map((t) => t.id)).toEqual(["b"]);
  expect(seen).toEqual(["activate b", "move b 0"]);
});

test("defaults: titles, isolation, closable; detachable per tab", () => {
  const { tabs } = group({ detachable: (t) => t.board !== "locked" }, [
    { id: "r", path: "/x", board: "r" },
    { id: "u", url: "https://example.com", board: "u" },
    { id: "l", path: "/y", board: "locked" },
    { id: "f", title: "Fixed", path: "/z", closable: false, board: "f" },
  ]);
  const [r, u, l, f] = tabs.items as [Board, Board, Board, Board];
  expect([tabs.titleOf(r), tabs.titleOf(u), tabs.titleOf(f)]).toEqual(["/x", "https://example.com", "Fixed"]);
  expect([tabs.isIsolated(r), tabs.isIsolated(u)]).toEqual([false, true]);
  expect([tabs.canDetach(r), tabs.canDetach(u), tabs.canDetach(l), tabs.canDetach(f)]).toEqual([true, false, false, false]);
  tabs.close("f");
  expect(tabs.items).toHaveLength(4); // not closable
});

test("keepAlive takes SvelteKit route ids; open(path) finds a kept-alive tab already open", () => {
  const m = (id: string, p: string) => routeMatcher(id).test(p);
  expect([m("/chat", "/chat"), m("/chat", "/chat/"), m("/chat", "/chats"), m("/chat", "/chat/x")]).toEqual([true, true, false, false]);
  expect([m("/terminal/[id]", "/terminal/main"), m("/terminal/[id]", "/terminal"), m("/terminal/[id]", "/terminal/a/b")]).toEqual([true, false, false]);
  expect([m("/docs/[...rest]", "/docs"), m("/docs/[...rest]", "/docs/a/b"), m("/(app)/[[lang]]/home", "/home"), m("/(app)/[[lang]]/home", "/fr/home")]).toEqual([true, true, true, true]);
  expect([m("/", "/"), m("/", "/x"), m("/v1.2/[id=int]", "/v1.2/3"), m("/v1.2/[id=int]", "/v1x2/3")]).toEqual([true, false, true, false]);

  const { store, tabs } = group({ keepAlive: ["/terminal/[id]"] }, []);
  const a = tabs.open("/terminal/main");
  expect(tabs.isIsolated(a)).toBe(true);
  tabs.open("/settings");
  expect(tabs.open("/terminal/main?x=1").id).toBe(a.id); // the one already open
  expect(tabs.isIsolated(tabs.open("https://example.com"))).toBe(true);
  expect(store.items.map((t) => t.path ?? t.url)).toEqual(["/terminal/main", "https://example.com", "/settings"]); // opened next to the active one
});

// In panes (split): what the group does with the tree.
function split(options: TabsOptions<Board> = {}) {
  const items: Board[] = [{ id: "a", title: "A", board: "a" }, { id: "b", title: "B", board: "b" }];
  const store = { items, active: undefined as string | undefined };
  const tabs = new TabGroup<Board>(() => ({ split: true, newTab: () => ({ title: "New", board: "n" }), ...options }), store);
  return { store, tabs, panes: tabs.panes! };
}

test("panes: splitting leaves the pane it came from showing what it showed", () => {
  const { tabs, panes } = split();
  expect(panes.focused.active).toBe("a");
  const made = tabs.split("right")!;
  expect(panes.pane("p0")!.active).toBe("a");
  expect(panes.pane("p0")!.tabs).toEqual(["a", "b"]);
  expect(tabs.activeId).toBe(made.id);
  expect(panes.focused.active).toBe(made.id);
});

test("panes: a split in the background moves neither the focus nor the active tab", () => {
  const { tabs, panes } = split();
  tabs.open({ title: "C", board: "c" }, { split: "right", background: true });
  expect(panes.panes.length).toBe(2);
  expect(tabs.activeId).toBe("a");
  expect(panes.focused.active).toBe("a");
});

test("panes: a pane that's gone: the tab opens anyway, in a pane", () => {
  const { tabs, panes } = split();
  const made = tabs.open({ title: "C", board: "c" }, { pane: "nope", split: "right" });
  expect(panes.paneOf(made.id)).toBeDefined();
  expect(tabs.items.map((t) => t.id)).toContain(made.id);
  const other = tabs.open({ title: "D", board: "d" }, { pane: "nope" });
  expect(panes.paneOf(other.id)).toBeDefined();
});

test("panes: move() is the place in the pane's bar", () => {
  const { tabs, panes } = split();
  tabs.move("b", 0);
  expect(panes.pane("p0")!.tabs).toEqual(["b", "a"]);
  expect(panes.pane("p0")!.active).toBe("a");
});

test("panes: new tabs stay after the pinned ones", () => {
  const store = { items: [{ id: "p", title: "P", board: "p", pinned: true }, { id: "a", title: "A", board: "a" }] as Board[], active: undefined as string | undefined };
  const tabs = new TabGroup<Board>(() => ({ split: true }), store);
  tabs.open({ title: "C", board: "c", id: "c" }, { index: 0 });
  expect(tabs.panes!.focused.tabs).toEqual(["p", "c", "a"]);
});

test("panes: maxViews suspends what's not on screen, past what is", () => {
  const { tabs, panes } = split({ maxViews: 2 });
  const b = tabs.open({ title: "Left", board: "l", id: "l" });
  const r = tabs.open({ title: "Right", board: "r", id: "r" }, { split: "right" });
  panes.activate(b.id);
  panes.activate(r.id);
  const c = tabs.open({ title: "C", board: "c", id: "c" }, { background: true, pane: panes.paneOf(r.id)!.id });
  const d = tabs.open({ title: "D", board: "d", id: "d" }, { background: true, pane: panes.paneOf(r.id)!.id });
  // Two on screen fill the two allowed: neither background tab runs.
  expect(tabs.suspended.has(c.id)).toBe(true);
  expect(tabs.suspended.has(d.id)).toBe(true);
  expect(tabs.suspended.has(b.id)).toBe(false);
  expect(tabs.suspended.has(r.id)).toBe(false);
});

test("panes: a pane without the focus finishing its switch counts for the limit", () => {
  const { tabs, panes } = split({ maxViews: 2 });
  tabs.close("b");
  tabs.open({ title: "B", board: "b", id: "b2" }, { split: "right" });
  tabs.reveal("a");
  tabs.reveal("b2");
  const right = panes.paneOf("b2")!.id;
  const c = tabs.open({ title: "C", board: "c", id: "c" }, { pane: right });
  tabs.focus(panes.paneOf("a")!.id);
  expect(tabs.suspended.has("b2")).toBe(false); // still on screen while c loads
  tabs.reveal(c.id); // c drawn: b2 is the one over the limit now
  expect(tabs.suspended.has("b2")).toBe(true);
  expect(tabs.suspended.has("a")).toBe(false);
  expect(tabs.suspended.has(c.id)).toBe(false);
});

test("panes: a suspended tab shown in a pane without the focus runs again", () => {
  const { tabs, panes } = split({ maxViews: 1 });
  tabs.open({ title: "R", board: "r", id: "r" }, { split: "right" });
  tabs.open({ title: "S", board: "s", id: "s" }, { background: true, pane: panes.paneOf("r")!.id });
  expect(tabs.suspended.has("s")).toBe(true);
  tabs.focus(panes.paneOf("a")!.id);
  tabs.close("r"); // its pane shows s, in the background
  tabs.reveal("s");
  expect(tabs.suspended.has("s")).toBe(false);
});

test("without panes the limit is as it was: the view of what was shown isn't the only one looked at", () => {
  const store = { items: [{ id: "a", path: "/chat/a" }] as TabLike[], active: "a" as string | undefined };
  const tabs = new TabGroup<TabLike>(() => ({ keepAlive: ["/chat/[id]"], maxViews: 1 }), store);
  tabs.open("/chat/b", { background: true, reuse: false });
  expect(tabs.suspended.size).toBe(0);
});

test("panes: every tab in its own view, a close moves to what its pane shows next", () => {
  const { tabs, panes, store } = split();
  expect(tabs.isIsolated(tabs.get("a")!)).toBe(true);
  expect(tabs.pageRendered).toBe(false);
  tabs.close("a");
  expect(store.active).toBe("b");
  expect(panes.focused.active).toBe("b");
  tabs.open({ title: "C", board: "c", id: "c" }, { split: "right" });
  tabs.close("c");
  expect(panes.panes.length).toBe(1);
  expect(store.active).toBe("b");
});

test("an address as SvelteKit reads it: what's distinct stays distinct", () => {
  expect(decodedPath("/caf%C3%A9")).toBe("/café");
  expect(decodedPath("/doc/a%2Fb")).toBe("/doc/a%2Fb");
  expect(decodedPath("/doc/a%252Fb")).toBe("/doc/a%252Fb");
  expect(decodedPath("/doc/a%2Fb")).not.toBe(decodedPath("/doc/a%252Fb"));
  expect(decodedPath("/bad%E0%A4%A")).toBe("/bad%E0%A4%A");
});

test("panes: tabs on routes that differ only by encoding are two tabs", () => {
  const store = { items: [] as TabLike[], active: undefined as string | undefined };
  const tabs = new TabGroup<TabLike>(() => ({ split: true, keepAlive: ["/doc/[id]"] }), store);
  const a = tabs.open("/doc/a%2Fb");
  const b = tabs.open("/doc/a%252Fb");
  expect(a.id).not.toBe(b.id);
  expect(tabs.open("/doc/a%2Fb").id).toBe(a.id);
  const cafe = tabs.open("/doc/caf%C3%A9");
  expect(tabs.open("/doc/café").id).toBe(cafe.id);
});

test("panes: tabs written from outside count for maxViews", () => {
  const { tabs, store } = split({ maxViews: 1 });
  store.items = [...store.items, { id: "c", title: "C", board: "c" }, { id: "d", title: "D", board: "d" }];
  tabs.panes!.reconcile(store.items.map((t) => t.id));
  tabs.syncViews();
  expect(["b", "c", "d"].every((id) => tabs.suspended.has(id))).toBe(true);
  expect(tabs.suspended.has("a")).toBe(false);
});

test("panes: tabs gone don't count for maxViews", () => {
  const { tabs, store } = split({ maxViews: 2 });
  tabs.close("b");
  tabs.open({ title: "B2", board: "b", id: "b2" }, { background: true });
  tabs.close("b2");
  store.items = [...store.items, { id: "c", title: "C", board: "c" }];
  tabs.panes!.reconcile(store.items.map((t) => t.id));
  tabs.syncViews();
  expect(tabs.suspended.has("c")).toBe(false);
});

test("panes: a new tab is a new tab, also on a keepAlive route already open", () => {
  const store = { items: [{ id: "a", path: "/" }] as TabLike[], active: undefined as string | undefined };
  const tabs = new TabGroup<TabLike>(() => ({ split: true, keepAlive: ["/"], newTab: () => ({ path: "/" }) }), store);
  const made = tabs.new()!;
  expect(made.id).not.toBe("a");
  expect(store.items.length).toBe(2);
});
