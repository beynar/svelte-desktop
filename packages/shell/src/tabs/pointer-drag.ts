// A press, moves and a release on an element, for a tab or the line between two panes. The pointer
// stays with the page it was pressed in, over other web views too; what can go wrong is the release
// not reaching us (outside the window, a system gesture), so a mouse moving with its button up ends
// the drag where the button was last down.
export interface PointerDragMove {
	event: PointerEvent;
	x: number;
	y: number;
	/** From the press, not the last move: the element follows the pointer, whatever it was clamped to. */
	deltaX: number;
	deltaY: number;
}

export interface PointerDragOptions {
	/** How far a press moves before it's a drag (px). 0: at the press. */
	threshold?: number;
	canStart?: (event: PointerEvent) => boolean;
	onStart?: (move: PointerDragMove) => void;
	onMove?: (move: PointerDragMove) => void;
	onEnd?: (move: PointerDragMove) => void;
	/** Escape, or the system took the pointer: a press that was a drag is undone. */
	onCancel?: () => void;
	/** The press ended without having been a drag (a click). */
	onPress?: () => void;
}

export function pointerDrag(node: HTMLElement, options: PointerDragOptions): () => void {
	let session: { pointer: number; x: number; y: number; active: boolean; last: PointerEvent } | null = null;

	const payload = (event: PointerEvent): PointerDragMove => ({
		event,
		x: event.clientX,
		y: event.clientY,
		deltaX: event.clientX - session!.x,
		deltaY: event.clientY - session!.y,
	});
	const close = () => {
		const s = session;
		session = null;
		removeEventListener('keydown', key, true);
		if (s && node.hasPointerCapture(s.pointer)) node.releasePointerCapture(s.pointer);
	};
	const cancel = () => {
		const active = session?.active;
		const was = !!session;
		close();
		if (active) options.onCancel?.();
		else if (was) options.onPress?.();
	};
	const end = (event: PointerEvent) => {
		const s = session;
		if (!s) return;
		const move = payload(event);
		close();
		if (s.active) options.onEnd?.(move);
		else options.onPress?.();
	};
	const activate = (event: PointerEvent) => {
		session!.active = true;
		options.onStart?.(payload(event));
	};
	const move = (event: PointerEvent) => {
		const s = session;
		if (!s || event.pointerId !== s.pointer) return;
		if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) return end(s.last);
		s.last = event;
		if (!s.active) {
			if (Math.hypot(event.clientX - s.x, event.clientY - s.y) < (options.threshold ?? 0)) return;
			activate(event);
		}
		options.onMove?.(payload(event));
	};
	const up = (event: PointerEvent) => void (event.pointerId === session?.pointer && end(event));
	const abort = (event: PointerEvent) => void (event.pointerId === session?.pointer && cancel());
	const lost = (event: PointerEvent) => void (event.target === node && abort(event));
	const key = (event: KeyboardEvent) => {
		if (event.key !== 'Escape' || !session?.active) return;
		event.preventDefault();
		event.stopPropagation();
		cancel();
	};
	const down = (event: PointerEvent) => {
		if (session || event.button !== 0 || options.canStart?.(event) === false) return;
		session = { pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, last: event };
		try {
			node.setPointerCapture(event.pointerId);
		} catch {
			/* no such pointer (a synthetic press): the events come here anyway */
		}
		addEventListener('keydown', key, true);
		if (!options.threshold) activate(event);
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', abort);
	node.addEventListener('lostpointercapture', lost);
	return () => {
		cancel();
		node.removeEventListener('pointerdown', down);
		node.removeEventListener('pointermove', move);
		node.removeEventListener('pointerup', up);
		node.removeEventListener('pointercancel', abort);
		node.removeEventListener('lostpointercapture', lost);
	};
}
