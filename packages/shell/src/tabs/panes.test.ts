// The tree of panes: splitting, moving tabs, what goes when a pane empties, what's saved.
import { expect, test } from "bun:test";
import { PaneLayout, type PaneNode } from "./panes.svelte.ts";

/** The tree in short: [a b] a pane (its tabs), row(…) and col(…) splits. */
const shape = (n: PaneNode): string =>
  n.type === "pane" ? `[${n.tabs.join(" ")}]` : `${n.direction === "row" ? "row" : "col"}(${n.children.map(shape).join(" ")})`;
const layout = (...tabs: string[]) => new PaneLayout(tabs);

test("a tab dropped on a side makes a pane there, and the focus follows", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  expect(shape(l.root)).toBe("row([a c] [b])");
  expect(l.focused.tabs).toEqual(["b"]);
  expect(l.pane("p0")!.active).toBe("a");
  l.moveBeside("c", "p0", "left");
  expect(shape(l.root)).toBe("row([c] [a] [b])");
});

test("the other direction nests a split in that pane; the same direction joins its parent", () => {
  const l = layout("a", "b", "c", "d");
  l.moveBeside("b", "p0", "right");
  const right = l.focused.id;
  l.moveBeside("c", right, "bottom");
  expect(shape(l.root)).toBe("row([a d] col([b] [c]))");
  l.moveBeside("d", right, "top");
  expect(shape(l.root)).toBe("row([a] col([d] [b] [c]))");
  const col = l.root.type === "split" ? l.root.children[1]! : null;
  expect(col?.type === "split" && col.sizes).toEqual([0.25, 0.25, 0.5]);
});

test("splitting shares the room of the pane split, not of the others", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", "p0", "right");
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.25, 0.25, 0.5]);
});

test("beside everything: a whole side of the window", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", l.focused.id, "bottom");
  expect(shape(l.root)).toBe("row([a] col([b] [c]))");
  l.moveBeside("a", null, "bottom"); // its pane goes, and what's left joins the same direction
  expect(shape(l.root)).toBe("col([b] [c] [a])");
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.25, 0.25, 0.5]);
});

test("a pane's last tab leaving takes the pane; a split with one child becomes that child", () => {
  const l = layout("a", "b");
  l.moveBeside("b", "p0", "right");
  expect(shape(l.root)).toBe("row([a] [b])");
  l.remove("b");
  expect(shape(l.root)).toBe("[a]");
  expect(l.focused.tabs).toEqual(["a"]);
  l.remove("a");
  expect(shape(l.root)).toBe("[]"); // the only pane stays
});

test("a nested split left with a split of the same direction merges, keeping the sizes", () => {
  const l = layout("a", "b", "c", "d");
  l.moveBeside("b", "p0", "right");
  const right = l.focused.id;
  l.moveBeside("c", right, "bottom");
  const low = l.focused.id;
  l.moveBeside("d", low, "right");
  expect(shape(l.root)).toBe("row([a] col([b] row([c] [d])))");
  l.remove("b");
  expect(shape(l.root)).toBe("row([a] [c] [d])");
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.5, 0.25, 0.25]);
});

test("moving to a bar: its place, the pane left shows the next tab", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("c", "p0", "right");
  const right = l.focused.id;
  l.activate("a");
  l.moveToPane("a", right, 0);
  expect(l.pane(right)!.tabs).toEqual(["a", "c"]);
  expect(l.pane(right)!.active).toBe("a");
  expect(l.pane("p0")!.active).toBe("b");
  l.moveToPane("c", right, 0); // within a pane
  expect(l.pane(right)!.tabs).toEqual(["c", "a"]);
});

test("a drop that changes nothing isn't one", () => {
  const l = layout("a");
  expect(l.allows("a", { kind: "side", pane: "p0", zone: "left" })).toBe(false);
  expect(l.allows("a", { kind: "center", pane: "p0" })).toBe(false);
  expect(l.allows("a", { kind: "root", zone: "left" })).toBe(false);
  l.moveBeside("a", "p0", "left");
  expect(shape(l.root)).toBe("[a]");
  const two = layout("a", "b");
  expect(two.allows("a", { kind: "side", pane: "p0", zone: "left" })).toBe(true);
});

test("resizing moves one boundary, the others stay, within the minimum", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", l.focused.id, "right");
  const sizes = () => (l.root.type === "split" ? [...l.root.sizes] : []);
  expect(sizes()).toEqual([0.5, 0.25, 0.25]);
  l.resizeTo(l.root.id, 0, 0.6);
  expect(sizes()[0]).toBeCloseTo(0.6);
  expect(sizes()[1]).toBeCloseTo(0.15);
  expect(sizes()[2]).toBe(0.25);
  l.resizeTo(l.root.id, 0, 5, 0.1); // past the end: what's left for the next one is the minimum
  expect(sizes()[0]).toBeCloseTo(0.65);
  expect(sizes()[1]).toBeCloseTo(0.1);
  l.resizeTo(l.root.id, 0, -5, 0.1);
  expect(sizes()[0]).toBeCloseTo(0.1);
  expect(sizes()[1]).toBeCloseTo(0.65);
});

test("a pane going: its room goes back where it came from, the others don't move", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  const right = l.focused.id; // row(a, b): 0.5, 0.5
  l.moveBeside("c", right, "left"); // row(a, c, b): c took from b
  const sizes = () => (l.root.type === "split" ? [...l.root.sizes] : []);
  expect(sizes()).toEqual([0.5, 0.25, 0.25]);
  l.remove("c");
  expect(sizes()).toEqual([0.5, 0.5]);
  // The pane it came from gone: the one next to it.
  const m = layout("a", "b", "c", "d");
  m.moveBeside("b", "p0", "right");
  const second = m.focused.id;
  m.moveBeside("c", second, "right");
  m.moveBeside("d", m.focused.id, "right"); // row(a, b, c, d): 0.5, 0.25, 0.125, 0.125
  m.remove("c"); // d came from c: c's room to b, before it
  expect(m.root.type === "split" && m.root.sizes).toEqual([0.5, 0.375, 0.125]);
  m.remove("d"); // from c, gone: to the pane before it
  expect(m.root.type === "split" && m.root.sizes).toEqual([0.5, 0.5]);
});

test("the pane it came from now in a nested split: the room goes to that branch, saved or not", () => {
  const make = () => {
    const l = layout("a", "b", "c", "d");
    l.moveBeside("b", "p0", "right");
    const b = l.focused.id;
    l.moveBeside("c", b, "left"); // row(a, c, b): c took from b
    l.moveBeside("d", b, "bottom"); // b in a column now
    return l;
  };
  const live = make();
  live.remove("c");
  expect(live.root.type === "split" && live.root.sizes).toEqual([0.5, 0.5]);
  const saved = JSON.parse(JSON.stringify(make().toJSON()));
  const back = layout("a", "b", "c", "d");
  expect(back.restore(saved, ["a", "b", "c", "d"])).toBe(true);
  back.remove("c");
  expect(back.root.type === "split" && back.root.sizes).toEqual([0.5, 0.5]);
});

test("a whole side going: its room goes back to all, as they were", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.resizeTo(l.root.id, 0, 0.6);
  l.moveBeside("c", null, "right");
  const sizes = () => (l.root.type === "split" ? l.root.sizes : []);
  expect(sizes()[2]).toBeCloseTo(1 / 3);
  const saved = JSON.parse(JSON.stringify(l.toJSON()));
  l.remove("c");
  expect(sizes()[0]).toBeCloseTo(0.6);
  expect(sizes()[1]).toBeCloseTo(0.4);
  const back = layout("a", "b", "c");
  back.restore(saved, ["a", "b", "c"]);
  back.remove("c");
  expect(back.root.type === "split" && back.root.sizes[0]).toBeCloseTo(0.6);
});

test("a boundary reset: the two beside it, equal; the others stay", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", l.focused.id, "right");
  l.resizeTo(l.root.id, 0, 0.6);
  l.resetBoundary(l.root.id, 0);
  const sizes = l.root.type === "split" ? l.root.sizes : [];
  expect(sizes[0]).toBeCloseTo(0.375);
  expect(sizes[1]).toBeCloseTo(0.375);
  expect(sizes[2]).toBe(0.25);
});

test("fit: every pane within the minimum when there's room, from those above it", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", l.focused.id, "right"); // 0.5, 0.25, 0.25
  const box = { width: 1000, height: 600 };
  l.fit(box, 400, { row: 0, column: 0 }); // no room for three at 400: as they are
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.5, 0.25, 0.25]);
  l.fit(box, 300, { row: 0, column: 0 }); // floor 0.3: the first gives what the others lack
  const sizes = l.root.type === "split" ? l.root.sizes : [];
  expect(sizes[0]).toBeCloseTo(0.4);
  expect(sizes[1]).toBeCloseTo(0.3);
  expect(sizes[2]).toBeCloseTo(0.3);
  expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  const before = l.revision;
  l.fit(box, 300, { row: 0, column: 0 }); // nothing to do
  expect(l.revision).toBe(before);
});

test("fit and the boundaries count what's nested: row(a, col(b, row(c, d)))", () => {
  const l = layout("a", "b", "c", "d");
  l.moveBeside("b", "p0", "right");
  const right = l.focused.id;
  l.moveBeside("c", right, "bottom");
  const low = l.focused.id;
  l.moveBeside("d", low, "right");
  if (l.root.type !== "split") throw new Error("a split");
  // 700 px: a needs 180, the right side 180 + 6 + 180. Evenly it would have 347: c and d 170 each.
  l.fit({ width: 700, height: 600 }, 180, { row: 6, column: 6 });
  const width = (i: number) => (l.root as any).sizes[i] * (700 - 6);
  expect(width(1)).toBeCloseTo(366);
  expect(width(0)).toBeCloseTo(694 - 366);
  // The outer boundary leaves the right side what it needs.
  const mins = l.minShares(l.root, 0, 180, { row: 6, column: 6 }, 994);
  expect(mins[0]).toBeCloseTo(180 / 994);
  expect(mins[1]).toBeCloseTo(366 / 994);
  l.resizeTo(l.root.id, 0, 0.9, mins);
  expect((l.root as any).sizes[1]).toBeCloseTo(366 / 994);
});

test("a column's boundaries count their own thickness, not a row's", () => {
  // row(a, col(b, row(c, col(d, e)))): the outer column needs 180 + 6 + (180 + 6 + 180 tall? no: as wide).
  const l = layout("a", "b", "c", "d", "e");
  l.moveBeside("b", "p0", "right");
  const b = l.focused.id;
  l.moveBeside("c", b, "bottom");
  const c = l.focused.id;
  l.moveBeside("d", c, "right");
  const d = l.focused.id;
  l.moveBeside("e", d, "bottom");
  const outer = (l.root as any).children[1];
  expect(outer.direction).toBe("column");
  // b 180, and below it c | (d over e): 180 + 8 + 180 tall.
  const mins = l.minShares(outer, 0, 180, { row: 600, column: 8 }, 992);
  expect(mins[0]).toBeCloseTo(180 / 992);
  expect(mins[1]).toBeCloseTo((180 + 8 + 180) / 992);
});

test("a boundary too tight for both: what they need, in proportion", () => {
  const l = layout("a", "b");
  l.moveBeside("b", "p0", "right");
  l.resizeTo(l.root.id, 0, 0.1, [0.6, 0.6]);
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.5, 0.5]);
  l.resizeTo(l.root.id, 0, 0.1, [0.75, 0.25]);
  expect(l.root.type === "split" && l.root.sizes).toEqual([0.75, 0.25]);
});

test("a very small pane stays above zero", () => {
  const l = layout(...Array.from({ length: 16 }, (_, i) => `t${i}`));
  for (let i = 1; i < 16; i++) l.moveBeside(`t${i}`, "p0", "right");
  if (l.root.type !== "split") throw new Error("a split");
  l.resetBoundary(l.root.id, 0);
  expect(l.root.sizes.every((s) => s > 0)).toBe(true);
  expect(l.root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
});

test("adding beside: the pane left keeps what it shows; in the background, the focus stays", () => {
  const l = layout("a", "b");
  l.addBeside("c", "p0", "right");
  expect(shape(l.root)).toBe("row([a b] [c])");
  expect(l.pane("p0")!.active).toBe("a");
  expect(l.focused.tabs).toEqual(["c"]);
  l.focus("p0");
  l.addBeside("d", "p0", "bottom", false);
  expect(l.focused.id).toBe("p0");
  // A pane that's gone: beside the focused one, not lost.
  l.addBeside("e", "nope", "right");
  expect(shape(l.root)).toContain("[e]");
  expect(l.paneOf("e")).toBeDefined();
});

test("split with nothing there: the empty pane takes it", () => {
  const l = new PaneLayout();
  l.addBeside("a", undefined, "right");
  expect(shape(l.root)).toBe("[a]");
  expect(l.focused.active).toBe("a");
});

test("moving beside a pane that's gone changes nothing", () => {
  const l = layout("a", "b");
  l.moveBeside("b", "nope", "right");
  expect(shape(l.root)).toBe("[a b]");
  expect(l.focused.id).toBe("p0");
});

test("reordering within a pane: the active one stays", () => {
  const l = layout("a", "b", "c");
  l.reorder("c", 0);
  expect(l.pane("p0")!.tabs).toEqual(["c", "a", "b"]);
  expect(l.pane("p0")!.active).toBe("a");
});

test("right to left: a side is where it looks, the first child on the right", () => {
  const l = layout("a", "b", "c");
  l.rtl = true;
  l.moveBeside("b", "p0", "right");
  expect(shape(l.root)).toBe("row([b] [a c])"); // first in the tree: drawn on the right
  l.moveBeside("c", "p0", "left");
  expect(shape(l.root)).toBe("row([b] [a] [c])");
  const e = l.edges();
  expect(e.get(l.paneOf("b")!.id)).toMatchObject({ right: true, left: false });
  expect(e.get(l.paneOf("c")!.id)).toMatchObject({ right: false, left: true });
});

test("tabs added or gone elsewhere follow; the focused pane takes the new ones", () => {
  const l = layout("a", "b");
  l.moveBeside("b", "p0", "right");
  l.reconcile(["a", "b", "c"]);
  expect(shape(l.root)).toBe("row([a] [b c])");
  expect(l.focused.active).toBe("b");
  l.reconcile(["a", "c"]);
  expect(shape(l.root)).toBe("row([a] [c])");
});

test("the tree is saved and restored; what's unknown is dropped", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  l.moveBeside("c", l.focused.id, "bottom");
  const saved = JSON.parse(JSON.stringify(l.toJSON()));
  const back = layout("a", "b", "c");
  expect(back.restore(saved, ["a", "b", "c"])).toBe(true);
  expect(shape(back.root)).toBe("row([a] col([b] [c]))");
  expect(back.focused.tabs).toEqual(["c"]);
  const fewer = layout("a", "c", "new");
  expect(fewer.restore(saved, ["a", "c", "new"])).toBe(true);
  expect(shape(fewer.root)).toBe("row([a] [c new])");
  expect(layout("a").restore({ root: { type: "nope" } }, ["a"])).toBe(false);
  expect(layout("a").restore(null, ["a"])).toBe(false);
});

test("a damaged saved tree: ids, tabs and sizes that can't be used are replaced", () => {
  const pane = (id: unknown, tabs: unknown[]) => ({ type: "pane", id, tabs, active: tabs[0] });
  const split = (id: unknown, sizes: unknown, children: unknown[]) => ({ type: "split", id, direction: "row", sizes, children });
  const ids = (l: PaneLayout) => [l.root.id, ...l.panes.map((p) => p.id)];

  // The same id twice, a split's too: each node its own.
  let l = layout("a", "b");
  expect(l.restore({ root: split("p", [0.5, 0.5], [pane("p", ["a"]), pane("p", ["b"])]) }, ["a", "b"])).toBe(true);
  expect(new Set(ids(l)).size).toBe(3);
  l.remove("b");
  expect(shape(l.root)).toBe("[a]"); // not the wrong one gone

  // A tab listed twice, in a pane or in two.
  l = layout("a");
  l.restore({ root: pane("x", ["a", "a"]) }, ["a"]);
  expect(l.panes[0]!.tabs).toEqual(["a"]);
  l = layout("a", "b");
  l.restore({ root: split("s", [0.5, 0.5], [pane("x", ["a", "b"]), pane("y", ["a"])]) }, ["a", "b"]);
  expect(shape(l.root)).toBe("[a b]");

  // Ids that would break a selector.
  l = layout("a", "b");
  l.restore({ root: split('bad"id', [0.5, 0.5], [pane('x"]', ["a"]), pane("y z", ["b"])]) }, ["a", "b"]);
  for (const id of ids(l)) expect(id).toMatch(/^[\w-]+$/);

  // Sizes: huge, infinite, negative, not numbers.
  for (const sizes of [[1e308, 1e308], ["Infinity", 1], [-1, 2], [NaN, 0], "nope", null]) {
    l = layout("a", "b");
    expect(l.restore({ root: split("s", sizes, [pane("x", ["a"]), pane("y", ["b"])]) }, ["a", "b"])).toBe(true);
    const got = l.root.type === "split" ? l.root.sizes : [];
    expect(got.every((s) => Number.isFinite(s) && s > 0)).toBe(true);
    expect(got.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  }

  // Next to the others it comes out as nothing: what's fair.
  l = layout("a", "b", "c");
  l.restore({ root: split("s", [5e-324, 1, 1], [pane("x", ["a"]), pane("y", ["b"]), pane("z", ["c"])]) }, ["a", "b", "c"]);
  expect(l.root.type === "split" && l.root.sizes.every((s) => s > 0.1)).toBe(true);

  // The focus follows an id that had to change, and so does `from`.
  l = layout("a", "b");
  l.restore({ root: split("s", [0.5, 0.5], [pane("x", ["a"]), { ...pane('y"', ["b"]), from: 'y"' }]), focused: 'y"' }, ["a", "b"]);
  expect(l.focused.tabs).toEqual(["b"]);
  expect(l.focused.from).toBe(l.focused.id);

  // Nested without end: not followed.
  let deep: unknown = pane("x", ["a"]);
  for (let i = 0; i < 5000; i++) deep = split(`s${i}`, [1], [deep]);
  l = layout("a");
  expect(() => l.restore({ root: deep }, ["a"])).not.toThrow();
  expect(l.paneOf("a")).toBeDefined();
});

test("tabs placed together keep their order", () => {
  expect(layout().root.type).toBe("pane");
  const l = new PaneLayout();
  l.reconcile(["a", "b", "c"]);
  expect(l.pane("p0")!.tabs).toEqual(["a", "b", "c"]);
  expect(l.pane("p0")!.active).toBe("a");
});

test("which panes touch the window's sides", () => {
  const l = layout("a", "b", "c");
  l.moveBeside("b", "p0", "right");
  const right = l.focused.id;
  l.moveBeside("c", right, "bottom");
  const low = l.focused.id;
  const e = l.edges();
  expect(e.get("p0")).toEqual({ top: true, left: true, bottom: true, right: false });
  expect(e.get(right)).toEqual({ top: true, left: false, bottom: false, right: true });
  expect(e.get(low)).toEqual({ top: false, left: false, bottom: true, right: true });
});
