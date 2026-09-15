// display-family recipes — pure style, no new machinery
import { recipe } from '../recipe.js';

export const separatorTheme = recipe({
	base: { bg: 'neutral-muted', shrink: 0 },
	variants: {
		orientation: {
			horizontal: { h: 1, w: 'full' },
			vertical: { w: 1, h: 'full' },
		},
	},
	defaultVariants: { orientation: 'horizontal' },
});

export const kbdTheme = recipe({
	base: {
		flex: true, items: 'center', justify: 'center',
		px: 'sm', h: 20, radius: 'sm', borderW: 1, border: 'neutral-muted',
		bg: 'surface-raised', fg: 'neutral-readable', text: 'xs', font: 'mono',
	},
});

export const avatarTheme = {
	root: recipe({
		base: {
			flex: true, items: 'center', justify: 'center', shrink: 0,
			radius: 'full', overflow: 'hidden', select: 'none',
			bg: 'color-muted', fg: 'color-muted-readable', fontW: 500,
		},
		variants: {
			size: {
				small: { icon: 'md', text: 'xs' },
				normal: { w: 32, h: 32, text: 'sm' },
				large: { w: 44, h: 44, text: 'base' },
			},
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
		},
		defaultVariants: { size: 'normal', color: 'neutral' },
	}),
};

export const alertTheme = {
	root: recipe({
		base: {
			row: true, gap: 'md', p: 'lg', radius: 'md',
			borderW: 1, border: 'color/30', bg: 'color-muted', fg: 'color-readable',
		},
		variants: {
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
			variant: {
				soft: null,
				solid: { bg: 'color', fg: 'color-contrast', border: 'color' },
				outline: { bg: 'transparent', border: 'color', fg: 'color-readable' },
			},
			size: { small: { p: 'sm', gap: 'sm' }, normal: null, large: { p: 'xl', gap: 'lg' } },
			dismissible: { true: null, false: null },
		},
		defaultVariants: { color: 'info', variant: 'soft', size: 'normal', dismissible: false },
	}),
	icon: recipe({ base: { shrink: 0, icon: 'md', fg: 'color-readable' } }),
	title: recipe({ base: { fontW: 500, fg: 'color-readable', text: 'sm' } }),
	body: recipe({ base: { col: true, gap: 'micro', text: 'sm', flex1: true } }),
	close: recipe({ base: { icon: 'sm', fg: 'color-readable', cursor: 'pointer', opacity: 0.7, shrink: 0, hover: { opacity: 1 } } }),
};

export const skeletonTheme = recipe({
	base: { bg: 'surface-floating', radius: 'sm' },
	variants: {
		shape: { line: { h: 14 }, circle: { radius: 'full', w: 40, h: 40 }, block: { h: 64 } },
	},
	defaultVariants: { shape: 'line' },
});

export const progressTheme = {
	track: recipe({
		base: { h: 6, w: 'full', radius: 'full', bg: 'surface-floating', overflow: 'hidden' },
	}),
	fill: recipe({
		base: { h: 'full', radius: 'full', bg: 'color' },
		variants: { color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null } },
		defaultVariants: { color: 'primary' },
	}),
	label: recipe({ base: { text: 'xs', fg: 'neutral-readable' } }),
};

export const spinnerTheme = recipe({
	base: { fg: 'color-readable' },
	variants: {
		size: { small: { icon: 'sm' }, normal: { icon: 'md' }, large: { icon: 'lg' } },
	},
	defaultVariants: { size: 'normal' },
});

export const statTheme = {
	root: recipe({
		base: { col: true, gap: 'xs' },
		variants: {
			size: { small: { gap: 'micro' }, normal: null, large: { gap: 'sm' } },
			density: { compact: null, normal: null, comfortable: null },
		},
		defaultVariants: { size: 'normal', density: 'normal' },
	}),
	label: recipe({ base: { text: 'xs', fg: 'neutral-readable' } }),
	value: recipe({
		base: { text: '2xl', fontW: 600, fg: 'neutral' },
		variants: { size: { small: { text: 'xl' }, normal: null, large: { text: '3xl' } } },
		defaultVariants: { size: 'normal' },
	}),
	unit: recipe({ base: { text: 'sm', fontW: 500, fg: 'neutral-readable' } }),
	delta: recipe({
		base: { text: 'xs' },
		variants: { trend: { up: { fg: 'success-readable' }, down: { fg: 'danger-readable' }, flat: { fg: 'neutral-readable' } } },
		defaultVariants: { trend: 'flat' },
	}),
};

export const emptyTheme = {
	root: recipe({
		base: { col: true, items: 'center', justify: 'center', gap: 'md', p: 'layout-lg' },
		variants: {
			size: { small: { p: 'lg', gap: 'sm' }, normal: null, large: { p: 'layout-xl', gap: 'lg' } },
			bordered: { true: { borderW: 1, border: 'neutral-muted', radius: 'md' }, false: null },
		},
		defaultVariants: { size: 'normal', bordered: false },
	}),
	iconWrap: recipe({ base: { icon: 'lg', fg: 'neutral-readable', opacity: 0.5, p: 'md', bg: 'surface-floating', radius: 'md' } }),
	icon: recipe({ base: { icon: 'lg', fg: 'neutral-readable', opacity: 0.5 } }),
	title: recipe({ base: { text: 'base', fontW: 500, fg: 'neutral' } }),
	description: recipe({ base: { text: 'sm', fg: 'neutral-readable', align: 'center' } }),
	note: recipe({ base: { text: 'xs', fg: 'neutral-readable', opacity: 0.8, align: 'center' } }),
	actions: recipe({ base: { row: true, gap: 'sm', pt: 'sm' } }),
};
