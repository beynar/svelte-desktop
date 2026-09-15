// buttonTheme — svelai's Button/button.theme.ts ported to style props.
// `color` is ctx, not a variant: every variant resolves through the `color-*`
// placeholder refs, so color needs no props of its own.
import { recipe } from '../recipe.js';

const affix = {
	flex: true, shrink: 0, items: 'center', justify: 'center', overflow: 'hidden',
};

export const buttonTheme = {
	root: recipe({
		base: {
			flex: true, shrink: 0, select: 'none', items: 'center', justify: 'center',
			whitespace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
			radius: 'md', borderW: 1, border: 'transparent',
			fontW: 500, text: 'sm',
		},
		variants: {
			size: {
				small: { control: 'sm', px: 'md', gap: 'sm', text: 'xs' },
				normal: { control: 'md', px: 'lg', gap: 'md', text: 'sm' },
				large: { control: 'lg', px: 'xl', gap: 'md', text: 'sm' },
			},
			color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
			variant: {
				solid: { stateLayer: true, bg: 'color', fg: 'color-contrast' },
				outline: { stateLayer: true, bg: 'color/0', border: 'color', fg: 'color-readable' },
				soft: { stateLayer: true, fg: 'color-muted-readable', bg: 'color-muted' },
				ghost: { stateLayer: true, fg: 'color-readable', bg: 'color/0' },
				link: { bg: 'transparent', fg: 'color-readable' },
			},
			loading: { true: { cursor: 'default', pointerEvents: 'none' }, false: null },
			disabled: { true: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' }, false: null },
			squared: { true: { px: 0 }, false: null },
			fullWidth: { true: { w: 'full' }, false: null },
		},
		defaultVariants: { color: 'neutral', variant: 'solid', size: 'normal' },
		compoundVariants: [
			{ color: 'neutral', variant: 'outline', style: { border: 'neutral-muted' } },
			{ squared: true, size: 'small', style: { w: 28 } },
			{ squared: true, size: 'normal', style: { w: 32 } },
			{ squared: true, size: 'large', style: { w: 36 } },
		],
	}),
	prefix: recipe({
		base: affix,
		variants: { size: { small: { icon: 'sm' }, normal: { icon: 'md' }, large: { icon: 'lg' } } },
		defaultVariants: { size: 'normal' },
	}),
	suffix: recipe({
		base: affix,
		variants: { size: { small: { icon: 'sm' }, normal: { icon: 'md' }, large: { icon: 'lg' } } },
		defaultVariants: { size: 'normal' },
	}),
};

// focus ring — merged by the component when focused (JS-driven; StyleDesc has
// no focus channel). Same visual as svelai's focus-visible:ring-2 ring-color/50.
export const buttonFocusRing = { ring: 2, ringColor: 'color/50' };
