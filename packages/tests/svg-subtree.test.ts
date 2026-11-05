/**
 * svg-subtree.test.ts — svg children stay DOM-inert; the element's `source`
 * custom prop carries the serialized document.
 *
 * `<svg>` is a leaf renderer natively (gpui::svg paints a whole document) —
 * nested `<path>`/`<circle>`/… must never materialize, and every mutation
 * inside the subtree re-serializes so authored markup stays live:
 *   - mount emits createElement 'svg' + setCustomProp 'source', no child ops
 *   - attribute/childList/text mutations re-emit the serialized document
 *   - authored tag case survives (linearGradient, clipPath)
 *   - root element-box attrs (class/style/id) stay out of the document
 *   - a materialized element moved into an svg dematerializes
 *   - an svg with no children emits no source (src/source attrs unaffected)
 */
import { describe, test, expect } from 'bun:test';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';

installGlobals();

const ops: unknown[][] = [];
setRenderer({
	applyBatch: (json: string) => {
		ops.push(...(JSON.parse(json) as unknown[][]));
		return [];
	},
} as never);

function drainOps(): unknown[][] {
	flush();
	return ops.splice(0);
}

function mountEl(tag = 'div') {
	const el = doc.createElement(tag);
	doc.body.appendChild(el);
	materializeRoot(el);
	return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const sourceOps = (emitted: unknown[][]) => emitted.filter((op) => op[0] === 'setCustomProp' && op[2] === 'source');
const lastSource = (emitted: unknown[][]) => sourceOps(emitted).at(-1)?.[3] as string | undefined;

describe('svg subtree — inert children, serialized source', () => {
	test('mount emits one svg element and a serialized source, no child ops', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', 'M4 4L12 12');
		svg.appendChild(path);
		host.appendChild(svg);
		const emitted = drainOps();

		expect(emitted).toContainEqual(['createElement', svg.nativeId, 'svg']);
		expect(emitted).toContainEqual(['appendChild', host.nativeId, svg.nativeId]);
		// the path never materializes — no createElement for it, no appendChild into the svg
		expect(path.nativeId).toBe(0);
		expect(emitted.some((op) => op[0] === 'appendChild' && op[1] === svg.nativeId)).toBe(false);
		const src = lastSource(emitted);
		expect(src).toContain('viewBox="0 0 16 16"');
		expect(src).toContain('<path d="M4 4L12 12"></path>');
		expect(src).toContain('xmlns="http://www.w3.org/2000/svg"');
	});

	test('attribute mutations inside the subtree re-emit the document', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const path = doc.createElementNS(SVG_NS, 'path');
		svg.appendChild(path);
		host.appendChild(svg);
		drainOps();

		path.setAttribute('d', 'M1 1L15 15');
		const emitted = drainOps();
		expect(lastSource(emitted)).toContain('d="M1 1L15 15"');
	});

	test('childList mutations re-serialize; removals drop the node', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const a = doc.createElementNS(SVG_NS, 'path');
		const b = doc.createElementNS(SVG_NS, 'circle');
		svg.appendChild(a);
		host.appendChild(svg);
		drainOps();

		svg.appendChild(b);
		expect(lastSource(drainOps())).toContain('<circle');

		svg.removeChild(a);
		const src = lastSource(drainOps());
		expect(src).not.toContain('<path');
		expect(src).toContain('<circle');
	});

	test('camelCase svg tags serialize with authored case', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const defs = doc.createElementNS(SVG_NS, 'defs');
		const grad = doc.createElementNS(SVG_NS, 'linearGradient');
		grad.setAttribute('id', 'g');
		defs.appendChild(grad);
		svg.appendChild(defs);
		host.appendChild(svg);
		const src = lastSource(drainOps());
		expect(src).toContain('<linearGradient id="g">');
		expect(src).toContain('</linearGradient>');
	});

	test('root box attrs stay out of the document; inner attrs stay verbatim', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'icon');
		svg.setAttribute('id', 'icon-1');
		svg.setAttribute('viewBox', '0 0 8 8');
		const rect = doc.createElementNS(SVG_NS, 'rect');
		rect.setAttribute('id', 'box');
		rect.setAttribute('class', 'fill');
		svg.appendChild(rect);
		host.appendChild(svg);
		const src = lastSource(drainOps())!;
		expect(src).not.toMatch(/<svg[^>]*class/);
		expect(src).not.toMatch(/<svg[^>]*id="icon-1"/);
		expect(src).toContain('<rect id="box" class="fill">');
	});

	test('a materialized element moved into an svg dematerializes', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const live = doc.createElement('div');
		host.appendChild(svg);
		host.appendChild(live);
		drainOps();
		const liveId = live.nativeId;
		expect(liveId).not.toBe(0);

		svg.appendChild(live);
		const emitted = drainOps();
		expect(live.nativeId).toBe(0);
		expect(emitted).toContainEqual(['destroyElement', liveId]);
		expect(lastSource(emitted)).toContain('<div');
	});

	test('text inside <text> serializes; data writes re-emit', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const t = doc.createElementNS(SVG_NS, 'text');
		const tn = doc.createTextNode('hi');
		t.appendChild(tn);
		svg.appendChild(t);
		host.appendChild(svg);
		expect(lastSource(drainOps())).toContain('<text>hi</text>');
		expect(tn.nativeId).toBe(0);

		tn.data = 'bye';
		expect(lastSource(drainOps())).toContain('<text>bye</text>');
	});

	test('an svg with no children emits no source — src attr unaffected', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('src', 'icon.svg');
		host.appendChild(svg);
		const emitted = drainOps();
		expect(sourceOps(emitted)).toEqual([]);
		expect(emitted).toContainEqual(['setCustomProp', svg.nativeId, 'src', 'icon.svg']);
	});

	test('width/height attrs size the element box at lowest priority', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 16 16');
		host.appendChild(svg);
		const emitted = drainOps();
		const style = emitted.find((op) => op[0] === 'setStyle' && op[1] === svg.nativeId)?.[2] as Record<string, unknown>;
		expect(style?.width).toBe(16);
		expect(style?.height).toBe(16);

		svg.setAttribute('width', '24'); // live attr write re-pushes the box
		const style2 = drainOps().find((op) => op[0] === 'setStyle' && op[1] === svg.nativeId)?.[2] as Record<string, unknown>;
		expect(style2?.width).toBe(24);

		svg.style.width = '32px'; // author style wins over the presentation attr
		const style3 = drainOps().find((op) => op[0] === 'setStyle' && op[1] === svg.nativeId)?.[2] as Record<string, unknown>;
		expect(style3?.width).toBe(32);
	});

	test('empty attrs serialize as k="" — bare attrs are malformed XML', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('marker-end', ''); // DOM: valueless attr reads ''
		svg.appendChild(path);
		host.appendChild(svg);
		const src = lastSource(drainOps())!;
		expect(src).toContain('marker-end=""');
		expect(src).not.toMatch(/marker-end(?!=)/); // never a bare name
	});

	test('namespaced attrs survive innerHTML parsing and setAttribute', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.innerHTML = `<use xlink:href="#a" xml:space="preserve"/><image href="data:image/png;base64,x"/>`;
		host.appendChild(svg);
		const src = lastSource(drainOps())!;
		expect(src).toContain('xlink:href="#a"');
		expect(src).toContain('xml:space="preserve"');
		expect(src).toContain('href="data:image/png;base64,x"');
	});

	test('removeAttribute drops the attr from the document', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('opacity', '0.5');
		svg.appendChild(path);
		host.appendChild(svg);
		drainOps();

		path.removeAttribute('opacity');
		expect(lastSource(drainOps())).not.toContain('opacity');
	});

	test('svg removed and remounted re-ships its source', () => {
		const host = mountEl();
		const svg = doc.createElementNS(SVG_NS, 'svg');
		const path = doc.createElementNS(SVG_NS, 'path');
		svg.appendChild(path);
		host.appendChild(svg);
		drainOps();

		host.removeChild(svg);
		drainOps();
		host.appendChild(svg); // fresh materialize — ledger replays source
		const emitted = drainOps();
		expect(emitted).toContainEqual(['createElement', svg.nativeId, 'svg']);
		expect(lastSource(emitted)).toContain('<path');
	});
});
