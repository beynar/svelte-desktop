import { recipe } from '../recipe.js';

const DENSITY = {
	compact: { py: 'lg', gap: 'lg' },
	normal: { py: 'xl', gap: 'xl' },
	comfortable: { py: 'layout-md', gap: 'layout-md' },
};

export const cardTheme = {
	root: recipe({
		base: { col: true, radius: 'lg' },
		variants: {
			size: { small: { text: 'xs' }, normal: { text: 'sm' }, large: { text: 'base' } },
			density: DENSITY,
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
			variant: {
				solid: { bg: 'color', fg: 'color-contrast', ring: 1, ringColor: 'neutral/10', shadow: 'xs' },
				outline: { bg: 'transparent', fg: 'color-readable', ring: 1, ringColor: 'color' },
				soft: { bg: 'color-muted', fg: 'color-muted-readable' },
				ghost: { bg: 'transparent', fg: 'neutral' },
			},
			clickable: {
				true: { stateLayer: true, cursor: 'pointer', select: 'none' },
				false: null,
			},
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed' }, false: null },
		},
		defaultVariants: { size: 'normal', density: 'normal', color: 'neutral', variant: 'solid', clickable: false, disabled: false },
		compoundVariants: [
			{ clickable: true, variant: 'solid', style: { hover: { ring: 1, ringColor: 'neutral/25', shadow: 'sm' } } },
			{ color: 'neutral', variant: 'solid', style: { bg: 'surface-raised', fg: 'neutral' } },
			{ color: 'neutral', variant: 'outline', style: { ring: 1, ringColor: 'neutral/15', fg: 'neutral' } },
		],
	}),
	header: recipe({
		base: { grid: true, items: 'start' },
		variants: {
			density: {
				compact: { px: 'lg', gap: 'micro' },
				normal: { px: 'xl', gap: 'xs' },
				comfortable: { px: 'layout-md', gap: 'sm' },
			},
			hasAction: { true: { gridCols: 2 }, false: null },
			hasBorder: { true: { borderB: 1, border: 'neutral-muted' }, false: null },
		},
		defaultVariants: { density: 'normal', hasAction: false, hasBorder: false },
		compoundVariants: [
			{ hasBorder: true, density: 'compact', style: { pb: 'lg' } },
			{ hasBorder: true, density: 'normal', style: { pb: 'xl' } },
			{ hasBorder: true, density: 'comfortable', style: { pb: 'layout-md' } },
		],
	}),
	title: recipe({
		base: { fontW: 500 },
		variants: {
			size: { small: { text: 'sm' }, normal: { text: 'base' }, large: { text: 'lg' } },
			variant: {
				solid: { fg: 'color-contrast' },
				outline: { fg: 'color-readable' },
				soft: { fg: 'color-muted-readable' },
				ghost: { fg: 'color-readable' },
			},
		},
		defaultVariants: { size: 'normal' },
		compoundVariants: [
			// svelai's group-data-[color=neutral]/card:text-neutral — compile-time condition
			{ color: 'neutral', variant: 'solid', style: { fg: 'neutral' } },
			{ color: 'neutral', variant: 'outline', style: { fg: 'neutral' } },
			{ color: 'neutral', variant: 'ghost', style: { fg: 'neutral' } },
		],
	}),
	description: recipe({
		base: { fg: 'neutral/65' },
		variants: {
			size: { small: { text: 'xs' }, normal: { text: 'sm' }, large: { text: 'base' } },
		},
		defaultVariants: { size: 'normal' },
	}),
	content: recipe({
		base: { col: true },
		variants: {
			density: {
				compact: { px: 'lg', gap: 'md' },
				normal: { px: 'xl', gap: 'md' },
				comfortable: { px: 'layout-md', gap: 'lg' },
			},
		},
		defaultVariants: { density: 'normal' },
	}),
	footer: recipe({
		base: { flex: true, items: 'center' },
		variants: {
			density: {
				compact: { px: 'lg' },
				normal: { px: 'xl' },
				comfortable: { px: 'layout-md' },
			},
		},
		defaultVariants: { density: 'normal' },
	}),
};
