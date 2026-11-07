import { recipe } from '../recipe.js';

export const tabsTheme = {
	list: recipe({
		base: { row: true, gap: 'xs', borderB: 1, border: 'neutral-muted', shrink: 0 },
		variants: {
			variant: { line: null, pills: { borderB: 0, gap: 'xs', p: 'micro', bg: 'surface-recessed', radius: 'md', self: 'start' } },
		},
		defaultVariants: { variant: 'line' },
	}),
	trigger: recipe({
		base: {
			row: true, items: 'center', justify: 'center', px: 'lg', py: 'md',
			text: 'sm', fg: 'neutral-readable', cursor: 'pointer', select: 'none',
			borderB: 2, border: 'transparent', whitespace: 'nowrap',
			hover: { fg: 'neutral' },
		},
		variants: {
			variant: {
				line: null,
				pills: { borderB: 0, py: 'sm', radius: 'sm' },
			},
			active: { true: null, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { variant: 'line', active: false },
		compoundVariants: [
			{ variant: 'line', active: true, style: { fg: 'neutral', border: 'color', borderB: 2 } },
			{ variant: 'pills', active: true, style: { bg: 'surface-floating', fg: 'neutral', shadow: 'xs' } },
		],
	}),
	panel: recipe({ base: { col: true, flex1: true, py: 'lg' } }),
};

export const accordionTheme = {
	root: recipe({
		base: { col: true },
		variants: {
			splitted: { true: { gap: 'sm' }, false: null },
			density: { compact: { gap: 'micro' }, normal: null, comfortable: { gap: 'md' } },
		},
		defaultVariants: { splitted: false, density: 'normal' },
		compoundVariants: [{ splitted: false, style: { gap: 0 } }],
	}),
	item: recipe({
		base: { borderB: 1, border: 'neutral-muted' },
		variants: {
			variant: {
				classic: null,
				card: { bg: 'surface-raised', radius: 'md', borderW: 1, shadow: 'xs' },
				outline: { bg: 'transparent', radius: 'md', borderW: 1, border: 'neutral-muted' },
			},
			splitted: { true: { borderB: 0 }, false: null },
		},
		defaultVariants: { variant: 'classic', splitted: false },
		compoundVariants: [
			{ variant: 'card', splitted: false, style: { borderB: 1, borderT: 0, borderL: 0, borderR: 0, radius: 0 } },
			{ variant: 'outline', splitted: false, style: { borderT: 0, borderL: 0, borderR: 0, radius: 0 } },
		],
	}),
	trigger: recipe({
		base: {
			row: true, justify: 'between', items: 'center', w: 'full',
			px: 'md', py: 'lg', cursor: 'pointer', select: 'none',
			fg: 'neutral', fontW: 500, text: 'sm',
			hover: { fg: 'color-readable' },
		},
		variants: {
			disabled: { true: { opacity: 0.5, pointerEvents: 'none' }, false: null },
			size: { small: { py: 'sm', px: 'sm', text: 'xs' }, normal: null, large: { py: 'xl', px: 'lg', text: 'base' } },
		},
		defaultVariants: { disabled: false, size: 'normal' },
	}),
	content: recipe({ base: { px: 'md', pb: 'lg', text: 'sm', fg: 'neutral-readable' } }),
	chevron: recipe({ base: { icon: 'md', fg: 'neutral-readable', shrink: 0 } }),
};

export const sidebarTheme = {
	root: recipe({
		base: { col: true, gap: 'micro', p: 'md', bg: 'surface-recessed', h: 'full', overflowY: 'scroll' },
		variants: {
			collapsed: { true: { w: 52, p: 'sm', items: 'center' }, false: { w: 240 } },
			size: { small: null, normal: null, large: null },
			density: { compact: { p: 'sm', gap: 0 }, normal: null, comfortable: { p: 'lg', gap: 'xs' } },
		},
		defaultVariants: { collapsed: false, size: 'normal', density: 'normal' },
		compoundVariants: [
			{ collapsed: false, size: 'small', style: { w: 200 } },
			{ collapsed: false, size: 'large', style: { w: 300 } },
		],
	}),
	section: recipe({ base: { px: 'md', pt: 'md', pb: 'xs', text: 'xs', fontW: 600, fg: 'neutral-readable' } }),
	item: recipe({
		base: {
			row: true, items: 'center', gap: 'md', px: 'md', control: 'md',
			radius: 'sm', fg: 'neutral-readable', cursor: 'pointer', select: 'none',
			whitespace: 'nowrap', shrink: 0,
			hover: { bg: 'surface-floating', fg: 'neutral' },
		},
		variants: {
			active: { true: { bg: 'color-muted', fg: 'color-muted-readable' }, false: null },
			collapsed: { true: { justify: 'center', px: 0, w: 'full' }, false: null },
		},
		defaultVariants: { active: false, collapsed: false },
	}),
	icon: recipe({ base: { icon: 'md', shrink: 0 } }),
};

export const breadcrumbsTheme = {
	root: recipe({ base: { row: true, items: 'center', gap: 'sm', text: 'sm' } }),
	link: recipe({
		base: { fg: 'neutral-readable', cursor: 'pointer', hover: { fg: 'neutral' } },
		variants: { current: { true: { fg: 'neutral', fontW: 500, cursor: 'default' }, false: null } },
	}),
	sep: recipe({ base: { fg: 'neutral-readable' } }),
};

export const treeTheme = {
	root: recipe({ base: { col: true, gap: 'micro' } }),
	item: recipe({
		base: {
			row: true, items: 'center', gap: 'xs', px: 'sm', py: 'xs',
			radius: 'sm', cursor: 'pointer', select: 'none', fg: 'neutral-readable', text: 'sm',
			whitespace: 'nowrap',
			hover: { bg: 'surface-floating', fg: 'neutral' },
		},
		variants: { selected: { true: { bg: 'color-muted', fg: 'color-muted-readable' }, false: null } },
	}),
};

export const tableTheme = {
	root: recipe({ base: { col: true, w: 'full', text: 'sm' } }),
	headerRow: recipe({ base: { row: true, borderB: 1, border: 'neutral-muted' } }),
	headerCell: recipe({ base: { px: 'md', py: 'sm', text: 'xs', fontW: 600, fg: 'neutral-readable', flex1: true } }),
	row: recipe({
		base: { row: true, borderB: 1, border: 'neutral-muted', hover: { bg: 'surface-raised' } },
		variants: { selected: { true: { bg: 'color-muted' }, false: null }, clickable: { true: { cursor: 'pointer' }, false: null } },
	}),
	cell: recipe({ base: { px: 'md', py: 'sm', fg: 'neutral', flex1: true, ellipsis: true } }),
};

export const resizableTheme = {
	group: recipe({
		base: { w: 'full', h: 'full' },
		variants: { direction: { horizontal: { row: true }, vertical: { col: true } } },
		defaultVariants: { direction: 'horizontal' },
	}),
	pane: recipe({ base: { overflow: 'hidden' } }),
	divider: recipe({
		base: { bg: 'neutral-muted', shrink: 0, position: 'relative' },
		variants: {
			direction: {
				horizontal: { w: 4, h: 'full', cursor: 'col-resize' },
				vertical: { h: 4, w: 'full', cursor: 'row-resize' },
			},
			dragging: { true: { bg: 'primary' }, false: null },
			disabled: { true: { cursor: 'default', pointerEvents: 'none' }, false: null },
		},
		defaultVariants: { direction: 'horizontal', dragging: false, disabled: false },
		compoundVariants: [{ dragging: false, disabled: false, style: { hover: { bg: 'primary/60' } } }],
	}),
};

export const paginationTheme = {
	root: recipe({ base: { row: true, items: 'center', gap: 'xs' } }),
	info: recipe({ base: { text: 'xs', fg: 'neutral-readable', px: 'sm' } }),
};
