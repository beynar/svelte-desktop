// TabGroup on a plain store (bind:tabs / bind:active), and its callbacks.
import { expect, test } from "bun:test";
import { TabGroup, type TabLike, type TabsOptions } from "./tabs.svelte.ts";

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
  const { tabs } = group({ route: true, primary: true, detachable: (t) => t.board !== "locked" }, [
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
