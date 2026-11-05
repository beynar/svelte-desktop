<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { textareaTheme, focusRing } from './recipes/form.js';

	let {
		value = $bindable(null),
		defaultValue,
		placeholder = '',
		color,
		disabled = false,
		readOnly = false,
		invalid = false,
		minRows,
		maxRows,
		onchange,
		onValueChange,
		oninput,
		onfocus,
		onblur,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		...rest
	} = $props();

	value ??= defaultValue ?? '';
	const ct = componentTheme('textarea', () => theme);
	const vp = $derived(ct.props({ color, invalid, disabled }));
	let focused = $state(false);
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(
			mergeStyleDesc(
				style(ct.root(textareaTheme.root, vp, instStyle), ctx),
				resolveTokens(klass, ctx),
			),
			focused ? style(focusRing, ctx) : null,
		),
	);
</script>

<textarea
	use:applyStyle={resolved}
	use:nativeProps={{ placeholder, readOnly, minRows, maxRows }}
	{value}
	{disabled}
	oninput={(e) => { value = e.target.value; oninput?.(e); onchange?.(value); onValueChange?.(value); }}
	onfocus={(e) => { focused = true; onfocus?.(e); }}
	onblur={(e) => { focused = false; onblur?.(e); }}
	{...rest}
></textarea>
