// form-family recipes — wave-1 members (checkbox/switch/radio/segmented) plus
// the field wrapper. Input/Textarea/Slider/Select land in wave 2.
import { recipe } from '../recipe.js';

export const checkboxTheme = {
	box: recipe({
		base: {
			icon: 'md', radius: 'sm', borderW: 1, border: 'neutral-muted',
			flex: true, items: 'center', justify: 'center', cursor: 'pointer',
			shrink: 0, bg: 'surface-recessed', select: 'none',
		},
		variants: {
			checked: { true: { bg: 'color', border: 'color' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { checked: false, disabled: false },
		compoundVariants: [
			{ checked: false, style: { hover: { border: 'neutral-readable' } } },
		],
	}),
	check: recipe({ base: { icon: 'sm', fg: 'color-contrast' } }),
	label: recipe({ base: { text: 'sm', fg: 'neutral', cursor: 'pointer', select: 'none' } }),
};

export const switchTheme = {
	track: recipe({
		base: {
			w: 36, h: 20, radius: 'full', cursor: 'pointer', shrink: 0,
			bg: 'surface-floating', borderW: 1, border: 'neutral-muted',
			position: 'relative', select: 'none',
		},
		variants: {
			on: { true: { bg: 'color', border: 'color' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { on: false, disabled: false },
	}),
	knob: recipe({ base: { w: 16, h: 16, radius: 'full', bg: '#ffffff', position: 'absolute', top: 1, shadow: 'xs' } }),
	label: recipe({ base: { text: 'sm', fg: 'neutral', cursor: 'pointer', select: 'none' } }),
};

export const radioTheme = {
	circle: recipe({
		base: {
			icon: 'md', radius: 'full', borderW: 1, border: 'neutral-muted',
			flex: true, items: 'center', justify: 'center', cursor: 'pointer',
			shrink: 0, bg: 'surface-recessed', select: 'none',
		},
		variants: {
			checked: { true: { border: 'color' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { checked: false },
		compoundVariants: [{ checked: false, style: { hover: { border: 'neutral-readable' } } }],
	}),
	dot: recipe({ base: { w: 8, h: 8, radius: 'full', bg: 'color' } }),
	label: recipe({ base: { text: 'sm', fg: 'neutral', cursor: 'pointer', select: 'none' } }),
	group: recipe({ base: { col: true, gap: 'sm' } }),
};

export const segmentedTheme = {
	root: recipe({
		base: {
			row: true, p: 'micro', bg: 'surface-recessed', radius: 'md',
			gap: 'micro', self: 'start', borderW: 1, border: 'neutral-muted',
		},
		variants: {
			size: { small: null, normal: null, large: null },
		},
		defaultVariants: { size: 'normal' },
	}),
	item: recipe({
		base: {
			flex: true, items: 'center', justify: 'center', px: 'lg', gap: 'xs',
			radius: 'sm', fg: 'neutral-readable', cursor: 'pointer', select: 'none',
			whitespace: 'nowrap',
		},
		variants: {
			size: { small: { control: 'sm', text: 'xs' }, normal: { control: 'sm', text: 'sm' }, large: { control: 'md', text: 'sm' } },
			active: { true: { bg: 'surface-floating', fg: 'neutral', shadow: 'xs' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { size: 'normal', active: false },
	}),
};

export const inputTheme = {
	root: recipe({
		base: {
			control: 'md', px: 'lg', radius: 'md', w: 'full',
			bg: 'surface-recessed', borderW: 1, border: 'neutral-muted',
			fg: 'neutral', text: 'sm',
		},
		variants: {
			size: {
				small: { control: 'sm', px: 'md', text: 'xs' },
				normal: { control: 'md', px: 'lg', text: 'sm' },
				large: { control: 'lg', px: 'xl', text: 'sm' },
			},
			invalid: { true: { border: 'danger' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed' }, false: null },
		},
		defaultVariants: { size: 'normal' },
	}),
};

export const textareaTheme = {
	root: recipe({
		base: {
			p: 'md', radius: 'md', w: 'full',
			bg: 'surface-recessed', borderW: 1, border: 'neutral-muted',
			fg: 'neutral', text: 'sm',
		},
		variants: {
			invalid: { true: { border: 'danger' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed' }, false: null },
		},
	}),
};

export const sliderTheme = {
	root: recipe({ base: { position: 'relative', h: 20, w: 'full', flex: true, items: 'center', select: 'none' } }),
	track: recipe({ base: { h: 6, w: 'full', radius: 'full', bg: 'surface-floating' } }),
	fill: recipe({
		base: { h: 'full', radius: 'full', bg: 'color' },
		variants: { color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null } },
		defaultVariants: { color: 'primary' },
	}),
	thumb: recipe({
		base: {
			icon: 'md', radius: 'full', bg: '#ffffff', borderW: 1, border: 'neutral-muted',
			position: 'absolute', shadow: 'sm', cursor: 'grab',
		},
		variants: { dragging: { true: { cursor: 'grabbing' }, false: null }, disabled: { true: { opacity: 0.5 }, false: null } },
		defaultVariants: { dragging: false, disabled: false },
	}),
};

export const selectTheme = {
	trigger: recipe({
		base: {
			row: true, items: 'center', justify: 'between', gap: 'md',
			control: 'md', px: 'lg', radius: 'md', w: 'full',
			bg: 'surface-recessed', borderW: 1, border: 'neutral-muted',
			fg: 'neutral', text: 'sm', cursor: 'pointer', select: 'none',
		},
		variants: {
			open: { true: { ring: 2, ringColor: 'color/50' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { open: false, disabled: false },
	}),
	chevron: recipe({ base: { icon: 'md', fg: 'neutral-readable', shrink: 0 } }),
	content: recipe({
		base: {
			col: true, p: 'xs', radius: 'md', minW: 120, maxH: 280,
			bg: 'surface-floating', borderW: 1, border: 'neutral-muted', shadow: 'lg',
			overflowY: 'scroll', text: 'sm', fg: 'neutral',
		},
	}),
	item: recipe({
		base: {
			row: true, items: 'center', gap: 'sm', px: 'md', py: 'sm',
			radius: 'sm', text: 'sm', fg: 'neutral', cursor: 'pointer', select: 'none',
			whitespace: 'nowrap', shrink: 0,
		},
		variants: {
			highlighted: { true: { bg: 'neutral/12' }, false: null },
			selected: { true: null, false: null },
			disabled: { true: { opacity: 0.5, pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { highlighted: false, selected: false },
		compoundVariants: [
			{ highlighted: false, style: { hover: { bg: 'neutral/8' } } },
		],
	}),
	check: recipe({ base: { icon: 'sm', fg: 'color-readable', flex1: true, justify: 'end' }, variants: { color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null } }, defaultVariants: { color: 'primary' } }),
};

export const fieldTheme = {
	root: recipe({ base: { col: true, gap: 'xs' } }),
	label: recipe({ base: { text: 'sm', fontW: 500, fg: 'neutral' } }),
	hint: recipe({ base: { text: 'xs', fg: 'neutral-readable' } }),
	error: recipe({ base: { text: 'xs', fg: 'danger-readable' } }),
};

export const focusRing = { ring: 2, ringColor: 'color/50' };
