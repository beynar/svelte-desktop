// overlay helpers — anchored positioning + outside-dismiss plumbing
import { s } from './style.js';

/**
 * Props for a floating <anchored> layer.
 * - `at` given → absolute point anchor (context menus): position + corner.
 * - otherwise → anchors to the PARENT element via side/align/gap.
 * occlude+deferred+priority match gpuix's own FloatingLayer; occlude blocks
 * hit-testing through the panel and (with a focused child) enables
 * mouseDownOutside reporting.
 */
export function layerProps({ side = 'bottom', align = 'center', gap = 6, at = null } = {}) {
	const base = { side, align, gap, occlude: true, deferred: true, priority: 1, fit: 'snap', snapMargin: 8 };
	return at ? { ...base, position: { x: at.x, y: at.y }, anchor: 'topLeft' } : base;
}

/** props for a bare <anchored> at an absolute point (tooltips, hovercards) */
export function anchorAt(x, y, { side = 'bottom', align = 'start', gap = 0 } = {}) {
	return { position: { x, y }, side, align, gap, deferred: true };
}

/** scrim under a modal/popover — absolute fill over the window */
export const scrimStyle = (opacity = 0.5) =>
	s({ position: 'absolute', inset: 0, bg: `neutral/${opacity}`, flex: true, items: 'center', justify: 'center', pointerEvents: 'auto' });
