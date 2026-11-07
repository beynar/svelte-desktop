/**
 * QuickGUI backend: interprets the same op stream the gpuix renderer consumes
 * and applies it through @quickgui/native's retained-tree API (native-tree.ts).
 *
 * Op vocabulary (emitted by gdom.ts):
 *   createElement(id, tag)   setText(id, s)        setStyle(id, {camel: v})
 *   setCustomProp(id, k, v)  setEventListener(id, type, true)
 *   appendChild(pid, cid)    insertBefore(pid, cid, beforeId)
 *   destroyElement(id)       setRoot(id)
 *
 * Headless: RecordingHost implements the NativeNodeHost contract in pure JS —
 * no dylib, no window. Live: the real `Window` object is the host; its `root`
 * NativeNode is passed in and ops materialize against the Rust core.
 */
import {
	NativeNode,
	NativeNodeTag,
	PropertyCode,
	insertNativeNode,
	removeNativeNode,
	replaceNativeText,
	setNativeEventListener,
	setNativeProperty,
	parseColor,
	type NativeEventType,
	type QuickGuiEvent,
} from '@quickgui/native';
import { dispatchPayload } from './gdom';

// ── Tag mapping: our element tags → NativeNodeTag ─────────────────────────
// gdom already maps unknown html tags to 'div'; quickgui's vocabulary is a
// closed set, so anything unrecognized falls back to View.
const QG_TAG: Record<string, NativeNodeTag> = {
	div: NativeNodeTag.View,
	text: NativeNodeTag.View,
	button: NativeNodeTag.Button,
	input: NativeNodeTag.Input,
	textarea: NativeNodeTag.Input,
	markdown: NativeNodeTag.Markdown,
	'virtual-list': NativeNodeTag.VirtualList,
	svg: NativeNodeTag.Svg,
	img: NativeNodeTag.Image,
	image: NativeNodeTag.Image,
};

// ── Event mapping: our internal (gpuix-flavoured) names → quickgui types ──
// Notable: gpuix 'change' fires per-edit; quickgui's per-edit event is 'input'.
const QG_EVENT: Record<string, NativeEventType> = {
	click: 'click',
	mouseDown: 'mousedown',
	mouseUp: 'mouseup',
	mouseMove: 'mousemove',
	mouseEnter: 'mouseenter',
	mouseLeave: 'mouseleave',
	keyDown: 'keydown',
	keyUp: 'keyup',
	focus: 'focus',
	blur: 'blur',
	change: 'input',
	submit: 'submit',
	scroll: 'wheel',
};

// PropertyCode members are PascalCase versions of the camelCase names.
function propCode(name: string): PropertyCode | undefined {
	const pascal = name[0].toUpperCase() + name.slice(1);
	const code = (PropertyCode as Record<string, number>)[pascal];
	return code === undefined ? undefined : (code as PropertyCode);
}

// Codes whose values must be packed colors (mirrors solid's colorProperties set).
const COLOR_CODES = new Set<number>([
	PropertyCode.BackgroundColor,
	PropertyCode.Color,
	PropertyCode.BorderColor,
	PropertyCode.OutlineColor,
	PropertyCode.TextDecorationColor,
	PropertyCode.HoverBackgroundColor,
	PropertyCode.HoverColor,
	PropertyCode.ActiveBackgroundColor,
	PropertyCode.ActiveColor,
	PropertyCode.FocusBackgroundColor,
	PropertyCode.FocusColor,
	PropertyCode.TerminalCursorColor,
	PropertyCode.MarkdownBorderColor,
	PropertyCode.MarkdownMutedColor,
	PropertyCode.MarkdownLinkColor,
	PropertyCode.MarkdownCodeTextColor,
]);

/** css value → NativePropertyValue (mirrors their normalizeValue/normalizeLength). */
function normalizeProp(code: PropertyCode, value: unknown): boolean | number | string | null {
	if (value === null || value === undefined) return null;
	if (COLOR_CODES.has(code)) {
		try {
			return parseColor(value as number | string);
		} catch {
			return null; // unsupported color syntax — drop rather than crash the batch
		}
	}
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	const s = String(value).trim();
	if (s.endsWith('px')) {
		const n = Number(s.slice(0, -2));
		return Number.isFinite(n) ? n : null;
	}
	if (s === '0') return 0;
	const n = Number(s);
	return Number.isFinite(n) && s !== '' ? n : s;
}

export class QuickguiSink {
	/** our nativeId → NativeNode */
	readonly nodes = new Map<number, NativeNode>();
	/** setEventListener ops already wired — listener presence is idempotent there */
	private wired = new Set<string>();
	/** headless focus tracking (live host does its own) */
	lastFocused: number | null = null;
	/** host root that setRoot/inserts attach to */
	readonly root: NativeNode;

	constructor(root: NativeNode) {
		this.root = root;
		this.nodes.set(root.id, root);
	}

	/** Same signature as GpuixRenderer.applyBatch — called from native.ts flush(). */
	applyBatch(json: string): number[] {
		const ops = JSON.parse(json) as unknown[][];
		for (const op of ops) this.apply(op);
		return []; // quickgui tracks removal internally; nothing extra to unbind
	}

	private apply(op: unknown[]) {
		switch (op[0] as string) {
			case 'createElement': {
				const id = op[1] as number;
				const tag = op[2] as string;
				// gdom emits a 'text' element for DOM text nodes — that is a real
				// Text node in quickgui, not a View.
				const node =
					tag === 'text'
						? new NativeNode(NativeNodeTag.Text, '', id)
						: new NativeNode(QG_TAG[tag] ?? NativeNodeTag.View, '', id);
				if (tag === 'textarea') setNativeProperty(node, PropertyCode.Multiline, true);
				this.nodes.set(id, node);
				break;
			}
			case 'setText': {
				const node = this.nodes.get(op[1] as number);
				if (node && node.tag === NativeNodeTag.Text) replaceNativeText(node, op[2] as string);
				break;
			}
			case 'setStyle': {
				const node = this.nodes.get(op[1] as number);
				if (!node) break;
				for (const [k, v] of Object.entries(op[2] as Record<string, unknown>)) {
					const code = propCode(k);
					if (code !== undefined) setNativeProperty(node, code, normalizeProp(code, v));
				}
				break;
			}
			case 'setCustomProp': {
				const node = this.nodes.get(op[1] as number);
				if (!node) break;
				const code = propCode(op[2] as string);
				if (code !== undefined) setNativeProperty(node, code, normalizeProp(code, op[3]));
				break;
			}
			case 'setEventListener': {
				const id = op[1] as number;
				const type = op[2] as string;
				const node = this.nodes.get(id);
				const qg = QG_EVENT[type];
				if (!node || !qg) break;
				const key = `${id}:${qg}`;
				if (this.wired.has(key)) break;
				this.wired.add(key);
				setNativeEventListener(node, qg, (ev: QuickGuiEvent) => this.onNativeEvent(id, ev));
				break;
			}
			case 'appendChild': {
				const parent = this.nodes.get(op[1] as number);
				const child = this.nodes.get(op[2] as number);
				if (parent && child && child.parent !== parent) insertNativeNode(parent, child);
				break;
			}
			case 'insertBefore': {
				const parent = this.nodes.get(op[1] as number);
				const child = this.nodes.get(op[2] as number);
				const before = this.nodes.get(op[3] as number);
				if (!parent || !child) break;
				// their insertNativeNode throws on a bad anchor; ours tolerates
				if (before && before.parent === parent) insertNativeNode(parent, child, before);
				else if (child.parent !== parent) insertNativeNode(parent, child);
				break;
			}
			case 'destroyElement': {
				const node = this.nodes.get(op[1] as number);
				if (node?.parent) removeNativeNode(node.parent, node);
				break;
			}
			case 'setRoot': {
				const node = this.nodes.get(op[1] as number);
				if (node && node.parent !== this.root) insertNativeNode(this.root, node);
				break;
			}
		}
	}

	/** Native event → our DOM dispatch. value carries text edits / key names. */
	private onNativeEvent(id: number, ev: QuickGuiEvent) {
		// quickgui event names are already DOM-ish; dispatchPayload's domEvent()
		// passes unknown names through, so feed the type straight through.
		const payload: Record<string, unknown> = {
			elementId: id,
			eventType: ev.type,
			value: ev.value,
		};
		// keydown/keyup carry the key name in `value` on quickgui
		if (ev.type === 'keydown' || ev.type === 'keyup') payload.key = ev.value;
		dispatchPayload(payload as { elementId: number; eventType: string; value?: string });
	}

	// ── GpuixRenderer-shaped native methods (called via deferCall/deferAfterRender) ──

	focusElement(id: number) {
		const node = this.nodes.get(id);
		if (node) {
			this.lastFocused = id;
			node.focus(); // → host._focusNode → binding.focusHostedNode on a live window
		}
	}

	setWindowKeyEvents(keyDown: boolean, keyUp: boolean, sentinel: number) {
		// No window-key API: approximate by listening on the root — events bubble
		// up the parent chain, so focused-element keys reach the root listener.
		if (keyDown)
			setNativeEventListener(this.root, 'keydown', (ev) =>
				dispatchPayload({ elementId: sentinel, eventType: 'windowKeyDown', value: ev.value, key: ev.value } as never),
			);
		if (keyUp)
			setNativeEventListener(this.root, 'keyup', (ev) =>
				dispatchPayload({ elementId: sentinel, eventType: 'windowKeyUp', value: ev.value, key: ev.value } as never),
			);
	}

	/** No layout readback in @quickgui/native — honest null. */
	getElementBounds(_id: number): number[] | null {
		return null;
	}
	getScrollOffset(_id: number): number[] | null {
		return null;
	}
	scrollTo(_id: number, _x: number, _y: number) {}
	scrollToItem(_id: number, _index: number, _offset: number) {}

	/** Serialized native tree — conformance `tree()` equivalent. */
	getAutomationTree(): string {
		const tagName = (t: NativeNodeTag) =>
			t === NativeNodeTag.Text ? 'text'
			: t === NativeNodeTag.Input ? 'input'
			: t === NativeNodeTag.Button ? 'button'
			: 'div';
		const ser = (n: NativeNode): unknown => ({
			id: n.id,
			type: tagName(n.tag),
			text: n.tag === NativeNodeTag.Text ? n.text : undefined,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			children: n.children.map(ser),
		});
		return JSON.stringify(ser(this.root));
	}

	/** conformance `painted()` equivalent — every Text node's string, in order. */
	getPaintedText(): string[] {
		const out: string[] = [];
		const walk = (n: NativeNode) => {
			if (n.tag === NativeNodeTag.Text && n.text) out.push(n.text);
			n.children.forEach(walk);
		};
		walk(this.root);
		return out;
	}
}

// ── RecordingHost: NativeNodeHost in pure JS for headless tests ───────────

/** The subset of NativeNodeHost the tree actually calls (structural). */
export function createHeadlessRoot() {
	const ops: string[] = [];
	const root = new NativeNode(NativeNodeTag.View, '', 0);
	const host = {
		nativeId: 1,
		app: { nativeId: 1 },
		nodes: new Map<number, NativeNode>([[0, root]]),
		closed: false,
		flush() {
			return undefined;
		},
		_trackMount(_dispose: () => void) {
			return () => {};
		},
		_focusNode(node: NativeNode) {
			ops.push(`focus:${node.id}`);
			return true;
		},
		_enqueueCreate(n: NativeNode) {
			ops.push(`create:${n.id}:${NativeNodeTag[n.tag]}`);
		},
		_enqueueProperty(n: NativeNode, p: PropertyCode, v: unknown) {
			ops.push(`prop:${n.id}:${PropertyCode[p]}=${JSON.stringify(v)}`);
		},
		_enqueueText(n: NativeNode) {
			ops.push(`text:${n.id}=${JSON.stringify(n.text)}`);
		},
		_enqueueInsert(parent: NativeNode, child: NativeNode, before?: NativeNode) {
			ops.push(`insert:${parent.id}<-${child.id}${before ? `@${before.id}` : ''}`);
		},
		_enqueueRemove(parent: NativeNode, child: NativeNode) {
			ops.push(`remove:${parent.id}>-${child.id}`);
		},
		_enqueueCleanup(parent: NativeNode, children: readonly NativeNode[]) {
			ops.push(`cleanup:${parent.id}>-[${children.map((c) => c.id)}]`);
		},
	};
	root.host = host as never;
	root.materialized = true;
	return { root, host, ops };
}

/** Mirror of Window._dispatchEvent — bubble listeners up the parent chain. */
export function dispatchQgEvent(
	sink: QuickguiSink,
	targetId: number,
	type: NativeEventType,
	value?: string,
) {
	// synthesize through the same path a real native event takes: the node owns
	// a listener that forwards into our DOM dispatch.
	const node = sink.nodes.get(targetId);
	if (!node) return;
	const listener = node.listeners.get(type);
	if (!listener) throw new Error(`no ${type} listener on node ${targetId}`);
	listener({ type, target: node, currentTarget: node, value } as QuickGuiEvent);
}
