<script module>
	// module-level store — `toast('msg')` works from any component
	let seq = 0;
	const list = $state([]);
	export function toast(message, { color = 'neutral', duration = 3000, title } = {}) {
		const id = ++seq;
		list.push({ id, message, color, title });
		setTimeout(() => {
			const i = list.findIndex((t) => t.id === id);
			if (i !== -1) list.splice(i, 1);
		}, duration);
	}
</script>

<script>
	import { s } from './style.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fso } from './transitions.js';
	import { toastTheme, toastMotion } from './recipes/overlay.js';
	import { icons } from './icons.js';
	import { nativeProps } from './apply.js';

	let { theme = null, transition, class: klass = '', style = null, ...rest } = $props();
	const ct = useComponentTheme('toaster', theme, ['viewport', 'toast']);
	const mv = $derived(ct.motion(toastMotion, {}, transition));
	const viewportS = $derived(s(ct.slot('viewport', toastTheme.viewport, {}, style)));
	// toasts ride the tick lane both ways: `mx` margin offsets move flow elements
	const inP = $derived({ ...mv.spec?.in, duration: mv.in?.transition?.duration ? mv.in.transition.duration * 1000 : undefined, easing: mv.in?.transition?.ease });
	const outP = $derived({ ...mv.spec?.out, duration: mv.out?.ms, easing: mv.out?.transition?.ease });
	const iconFor = { success: 'success', danger: 'error', warning: 'warning', info: 'info' };
</script>

<div use:applyStyle={viewportS} class={klass} {...rest}>
	{#each list as t (t.id)}
		{@const ts = s(ct.slot('toast', toastTheme.toast, { color: t.color }), { color: t.color })}
		<div use:applyStyle={ts} in:fso={inP} out:fso={outP}>
			{#if iconFor[t.color]}
				<svg use:nativeProps={{ source: icons[iconFor[t.color]] }} use:applyStyle={s({ icon: 'md', fg: `${t.color}-readable`, shrink: 0 }, { color: t.color })}></svg>
			{/if}
			<div use:applyStyle={s({ col: true, gap: 'micro' })}>
				{#if t.title}<div use:applyStyle={s({ fontW: 600 })}>{t.title}</div>{/if}
				<div>{t.message}</div>
			</div>
		</div>
	{/each}
</div>
