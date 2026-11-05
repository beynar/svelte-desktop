import { recipe } from '../recipe.js';

export const chipTheme = {
	root: recipe({
		base: {
			flex: true, items: 'center', justify: 'center', whitespace: 'nowrap',
			radius: 'full', borderW: 1, border: 'transparent', fontW: 500,
			self: 'start',
		},
		variants: {
			isLink: { true: { cursor: 'pointer' }, false: null },
			isEmpty: { true: { p: 0 }, false: null },
			size: {
				small: { h: 20, px: 'md', gap: 'xs', text: 'xs' },
				normal: { h: 24, px: 'md', gap: 'sm', text: 'xs' },
				large: { h: 28, px: 'lg', gap: 'sm', text: 'sm' },
			},
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
			variant: {
				solid: { fg: 'color-contrast', bg: 'color' },
				outline: { bg: 'color/0', fg: 'color-readable', border: 'color' },
				soft: { bg: 'color-muted', fg: 'color-muted-readable' },
			},
		},
		defaultVariants: { color: 'neutral', variant: 'solid', size: 'normal' },
	}),
};
