// svelai recipes ported verbatim from ai2 — the test is whether the token
// vocabulary survives the backend swap unchanged.
import { cva } from './cva.js';

export const buttonTheme = {
	root: cva({
		base: 'group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap relative overflow-hidden cursor-pointer rounded-md border border-transparent bg-clip-padding font-medium text-sm outline-none transition-[color,background-color,border-color,box-shadow,translate] duration-fast ease-standard focus-visible:ring-2 focus-visible:ring-color/50 active:translate-y-px [&_svg:not([class*=size-])]:size-icon-md',
		variants: {
			size: {
				small: 'h-control-sm px-md gap-sm text-xs',
				normal: 'h-control-md px-lg gap-md text-sm',
				large: 'h-control-lg px-xl gap-md text-sm'
			},
			color: {
				primary: 'bg-primary text-primary-contrast',
				secondary: 'bg-secondary text-secondary-contrast',
				neutral: 'bg-neutral text-neutral-contrast',
				danger: 'bg-danger text-danger-contrast',
				success: 'bg-success text-success-contrast',
				warning: 'bg-warning text-warning-contrast',
				info: 'bg-info text-info-contrast'
			},
			variant: {
				solid: 'state-layer bg-color text-color-contrast',
				outline: 'state-layer bg-color/0 border border-color text-color-readable',
				soft: 'state-layer text-color-muted-readable bg-color-muted',
				ghost: 'state-layer text-color-readable bg-color/0',
				link: 'bg-transparent text-color-readable hover:underline'
			},
			loading: { true: 'cursor-default pointer-events-none', false: null },
			disabled: { true: 'opacity-50 cursor-not-allowed pointer-events-none', false: null },
			squared: { true: 'aspect-square !px-0', false: null },
			fullWidth: { true: 'w-full max-w-full' }
		},
		defaultVariants: { color: 'neutral', variant: 'solid', size: 'normal' },
		compoundVariants: [
			{ color: 'neutral', variant: 'outline', class: 'border-neutral-muted' }
		]
	}),
	prefix: cva({
		base: 'inline-flex shrink-0 items-center justify-center overflow-hidden leading-none [&_svg:not([class*=size-])]:!size-full',
		variants: { size: { normal: 'size-icon-md', large: 'size-icon-lg', small: 'size-icon-sm' } },
		defaultVariants: { size: 'normal' }
	}),
	suffix: cva({
		base: 'inline-flex shrink-0 items-center justify-center overflow-hidden leading-none [&_svg:not([class*=size-])]:!size-full',
		variants: { size: { normal: 'size-icon-md', large: 'size-icon-lg', small: 'size-icon-sm' } },
		defaultVariants: { size: 'normal' }
	})
};

export const chipTheme = {
	root: cva({
		base: 'group/chip box-border w-fit max-w-fit min-w-min inline-flex items-center justify-center whitespace-nowrap rounded-full border border-transparent bg-clip-padding font-medium transition-colors',
		variants: {
			isLink: { true: 'cursor-pointer', false: null },
			isEmpty: { true: 'max-w-none min-w-0 !p-0', false: null },
			size: {
				small: 'h-5 px-md gap-xs text-xs',
				normal: 'h-6 px-md gap-sm text-xs',
				large: 'h-7 px-lg gap-sm text-sm'
			},
			color: {
				primary: 'bg-primary text-primary-contrast',
				secondary: 'bg-secondary text-secondary-contrast',
				neutral: 'bg-neutral text-neutral-contrast',
				danger: 'bg-danger text-danger-contrast',
				success: 'bg-success text-success-contrast',
				warning: 'bg-warning text-warning-contrast',
				info: 'bg-info text-info-contrast'
			},
			variant: {
				solid: 'text-color-contrast bg-color',
				outline: 'bg-color/0 text-color-readable border-color',
				soft: 'bg-color-muted text-color-muted-readable'
			}
		},
		defaultVariants: { color: 'neutral', variant: 'solid', size: 'normal' }
	})
};

export const cardTheme = {
	root: cva({
		base: 'group/card text-neutral flex flex-col rounded-lg tabular-nums transition-[color,background-color,box-shadow,translate,opacity]',
		variants: {
			size: { small: 'text-xs', normal: 'text-sm', large: 'text-base' },
			density: {
				compact: 'py-lg gap-lg',
				normal: 'py-xl gap-xl',
				comfortable: 'py-layout-md gap-layout-md'
			},
			color: { primary: '', secondary: '', neutral: '', danger: '', success: '', warning: '', info: '' },
			variant: {
				solid: 'bg-color text-color-contrast ring-1 ring-neutral/10 shadow-xs',
				outline: 'bg-transparent text-color-readable ring-1 ring-color',
				soft: 'bg-color-muted text-color-muted-readable',
				ghost: 'bg-transparent text-neutral'
			},
			clickable: {
				true: 'state-layer cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-neutral/50 active:translate-y-px',
				false: ''
			},
			disabled: { true: 'opacity-50 cursor-not-allowed *:pointer-events-none', false: null }
		},
		defaultVariants: { size: 'normal', density: 'normal', color: 'neutral', variant: 'solid', clickable: false, disabled: false },
		compoundVariants: [
			{ clickable: true, variant: 'solid', class: 'hover:ring-neutral/25 hover:shadow-sm' },
			{ color: 'neutral', variant: 'solid', class: 'bg-surface-raised text-neutral' },
			{ color: 'neutral', variant: 'outline', class: 'ring-neutral/15 text-neutral' }
		]
	}),
	header: cva({
		base: 'grid auto-rows-min items-start',
		variants: {
			density: { compact: 'px-lg gap-micro', normal: 'px-xl gap-xs', comfortable: 'px-layout-md gap-sm' },
			hasAction: { true: 'grid-cols-[1fr_auto]', false: '' },
			hasBorder: { true: 'border-b border-neutral-muted', false: '' },
			variant: { solid: '', outline: '', soft: '', ghost: '' }
		},
		defaultVariants: { density: 'normal', hasAction: false, hasBorder: false },
		compoundVariants: [
			{ hasBorder: true, density: 'compact', class: 'pb-lg' },
			{ hasBorder: true, density: 'normal', class: 'pb-xl' },
			{ hasBorder: true, density: 'comfortable', class: 'pb-layout-md' }
		]
	}),
	title: cva({
		base: 'font-medium leading-normal',
		variants: {
			size: { small: 'text-sm', normal: 'text-base', large: 'text-lg' },
			variant: {
				solid: 'text-color-contrast group-data-[color=neutral]/card:text-neutral',
				outline: 'text-color-readable group-data-[color=neutral]/card:text-neutral',
				soft: 'text-color-muted-readable',
				ghost: 'text-color-readable group-data-[color=neutral]/card:text-neutral'
			}
		},
		defaultVariants: { size: 'normal' }
	}),
	description: cva({
		base: 'text-neutral/65 leading-normal',
		variants: { size: { small: 'text-xs', normal: 'text-sm', large: 'text-base' } },
		defaultVariants: { size: 'normal' }
	}),
	content: cva({
		base: 'flex flex-col',
		variants: {
			density: { compact: 'px-lg gap-md', normal: 'px-xl gap-md', comfortable: 'px-layout-md gap-lg' }
		},
		defaultVariants: { density: 'normal' }
	}),
	footer: cva({
		base: 'flex items-center',
		variants: {
			density: { compact: 'px-lg', normal: 'px-xl', comfortable: 'px-layout-md' }
		},
		defaultVariants: { density: 'normal' }
	})
};
