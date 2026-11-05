import { recipe } from '../recipe.js';

export const popoverTheme = recipe({
	base: {
		col: true, p: 'lg', radius: 'md', minW: 200, maxW: 320,
		bg: 'surface-floating', borderW: 1, border: 'neutral-muted', shadow: 'lg',
		text: 'sm', fg: 'neutral',
	},
});

export const tooltipTheme = recipe({
	base: {
		px: 'md', py: 'xs', radius: 'sm', maxW: 260,
		bg: 'surface-floating', borderW: 1, border: 'neutral-muted', shadow: 'md',
		text: 'xs', fg: 'neutral', whitespace: 'nowrap',
	},
});

export const hoverCardTheme = recipe({
	base: {
		col: true, gap: 'sm', p: 'lg', radius: 'md', w: 280,
		bg: 'surface-floating', borderW: 1, border: 'neutral-muted', shadow: 'lg',
		text: 'sm', fg: 'neutral',
	},
});

export const menuTheme = {
	content: recipe({
		base: {
			col: true, p: 'xs', radius: 'md', minW: 160, maxH: 320,
			bg: 'surface-floating', borderW: 1, border: 'neutral-muted', shadow: 'lg',
			overflowY: 'scroll', text: 'sm', fg: 'neutral',
		},
	}),
	item: recipe({
		base: {
			row: true, items: 'center', gap: 'sm', px: 'md', py: 'sm',
			radius: 'sm', text: 'sm', fg: 'neutral', cursor: 'pointer', select: 'none',
			whitespace: 'nowrap', shrink: 0,
			hover: { bg: 'neutral/8', fg: 'neutral' },
		},
		variants: {
			danger: { true: { fg: 'danger-readable' }, false: null },
			disabled: { true: { opacity: 0.5, pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { danger: false, disabled: false },
	}),
	separator: recipe({ base: { h: 1, bg: 'neutral-muted', my: 'xs', mx: 'xs' } }),
	label: recipe({ base: { px: 'md', py: 'xs', text: 'xs', fontW: 600, fg: 'neutral-readable' } }),
};

export const dialogTheme = {
	card: recipe({
		base: {
			col: true, gap: 'md', p: 'layout-md', radius: 'lg', w: 480, maxW: 560,
			bg: 'surface-raised', borderW: 1, border: 'neutral-muted', shadow: 'lg',
		},
		variants: {
			size: { small: { w: 360 }, normal: { w: 480 }, large: { w: 640 } },
			scroll: { true: { maxH: '80%', overflowY: 'scroll' }, false: null },
		},
		defaultVariants: { size: 'normal', scroll: false },
	}),
	title: recipe({ base: { text: 'lg', fontW: 600, fg: 'neutral' } }),
	description: recipe({ base: { text: 'sm', fg: 'neutral-readable' } }),
	footer: recipe({ base: { row: true, justify: 'end', gap: 'sm' } }),
};

export const toastTheme = {
	viewport: recipe({
		base: { position: 'absolute', right: 16, bottom: 16, col: true, gap: 'sm', w: 340, pointerEvents: 'none' },
	}),
	toast: recipe({
		base: {
			row: true, items: 'center', gap: 'md', p: 'lg', radius: 'md',
			bg: 'surface-floating', borderW: 1, border: 'color/40', shadow: 'lg',
			fg: 'neutral', text: 'sm', pointerEvents: 'auto',
		},
		variants: {
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
		},
		defaultVariants: { color: 'neutral' },
	}),
};

// ── motion presets — the `motion` slot of each overlay's theme ────────
// FrameSpec keys: opacity, x, y (insets), mx, my (margin offsets for flow
// elements), w/h, radius, top/left/right/bottom + duration/easing tokens.

export const popoverMotion = { in: { opacity: 0 }, out: { opacity: 0 }, duration: 'fast', easing: 'standard' };
export const menuMotion = { in: { opacity: 0 }, out: { opacity: 0 }, duration: 'fast', easing: 'standard' };
export const selectMotion = { in: { opacity: 0 }, out: { opacity: 0 }, duration: 'fast', easing: 'standard' };
export const tooltipMotion = { in: { opacity: 0 }, out: { opacity: 0 }, duration: 'fast', easing: 'enter' };
export const hoverCardMotion = { in: { opacity: 0 }, out: { opacity: 0 }, duration: 'normal', easing: 'standard' };
export const dialogMotion = {
	// card fades in; scrim fades — gpuix has no scale transform, opacity carries it
	in: { opacity: 0 },
	out: { opacity: 0 },
	duration: 'normal',
	easing: 'standard',
};
export const toastMotion = { in: { opacity: 0, mx: 24 }, out: { opacity: 0, mx: 24 }, duration: 'normal', easing: 'enter' };
