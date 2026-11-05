<script>
	import Menu from './Menu.svelte';

	let { items = [], open = $bindable(false), onclose, onOpenChange, children, ...rest } = $props();
	let at = $state(null);
	const openAt = (e) => {
		e.preventDefault?.();
		at = { x: e.x ?? 0, y: e.y ?? 0 };
		open = true;
		onOpenChange?.(true);
	};
</script>

<span
	style="display:flex;flex-direction:column"
	oncontextmenu={openAt}
	onauxclick={(e) => { if (e.button === 2 || e.isRightClick) openAt(e); }}
>
	{@render children?.()}
</span>
<Menu bind:open {items} {at} {onclose} {onOpenChange} {...rest} />
