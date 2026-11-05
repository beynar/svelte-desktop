// buttonTheme — svelai's Button/button.theme.ts ported to style props.
// Multi-slot recipe: one variant tuple drives root/prefix/suffix —
// `color` is ctx, not a variant: every variant resolves through the
// `color-*` placeholder refs, so color needs no props of its own.
import { recipe } from '../recipe.js';

const affix = {
	flex: true, shrink: 0, items: 'center', justify: 'center', overflow: 'hidden',
};

export const buttonTheme = recipe({
	slots: {
		root: {
			flex: true, shrink: 0, select: 'none', items: 'center', justify: 'center',
			whitespace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
			radius: 'md', borderW: 1, border: 'transparent',
			fontW: 500, text: 'sm',
			// svelai `focus-visible:ring-2 focus-visible:ring-color/50` — the
			// native focusVisible bucket follows real keyboard-focus semantics.
			focusVisible: { ring: 2, ringColor: 'color/50' },
		},
		prefix: affix,
		suffix: affix,
	},
	variants: {
		size: {
			small:  {
				root: { control: 'sm', px: 'md', gap: 'sm', text: 'xs' },
				prefix: { icon: 'sm' }, suffix: { icon: 'sm' },
			},
			normal: {
				root: { control: 'md', px: 'lg', gap: 'md', text: 'sm' },
				prefix: { icon: 'md' }, suffix: { icon: 'md' },
			},
			large:  {
				root: { control: 'lg', px: 'xl', gap: 'md', text: 'sm' },
				prefix: { icon: 'lg' }, suffix: { icon: 'lg' },
			},
		},
		color: { primary: null, secondary: null, neutral: null, danger: null, success: null, warning: null, info: null },
		variant: {
			solid:   { root: { stateLayer: true, bg: 'color', fg: 'color-contrast' } },
			outline: { root: { stateLayer: true, bg: 'color/0', border: 'color', fg: 'color-readable' } },
			soft:    { root: { stateLayer: true, fg: 'color-muted-readable', bg: 'color-muted' } },
			ghost:   { root: { stateLayer: true, fg: 'color-readable', bg: 'color/0' } },
			link:    { root: { bg: 'transparent', fg: 'color-readable', hover: { underline: true } } },
		},
		loading:  { true: { root: { cursor: 'default', pointerEvents: 'none' } }, false: null },
		disabled: { true: { root: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } }, false: null },
		// svelai `aspect-square !px-0` — width follows the control height
		squared:  { true: { root: { aspect: 1, px: 0 } }, false: null },
		fullWidth: { true: { root: { w: 'full', maxW: 'full' } }, false: null },
	},
	defaultVariants: { color: 'neutral', variant: 'solid', size: 'normal' },
	compoundVariants: [
		{ color: 'neutral', variant: 'outline', slots: ['root'], style: { border: 'neutral-muted' } },
	],
}, 'button');
