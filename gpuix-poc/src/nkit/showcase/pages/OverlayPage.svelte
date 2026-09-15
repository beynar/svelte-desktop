<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Popover from '../../Popover.svelte';
	import Tooltip from '../../Tooltip.svelte';
	import HoverCard from '../../HoverCard.svelte';
	import Menu from '../../Menu.svelte';
	import ContextMenu from '../../ContextMenu.svelte';
	import Button from '../../Button.svelte';
	import Avatar from '../../Avatar.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const row = $derived(s({ row: true, gap: 'lg', items: 'center' }));
	const cap = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
	const menuItems = [
		{ label: 'Edit' }, { label: 'Duplicate' }, 'separator',
		{ label: 'Delete', danger: true },
	];
</script>

<ComponentPage title="Popover / Tooltip / HoverCard / Menu" description="anchored overlays — click-outside dismiss">
	{#snippet demo()}
		<div use:applyStyle={row}>
			<Popover side="bottom" align="start">
				{#snippet trigger()}<Button variant="soft" size="small" label="Popover" />{/snippet}
				<div use:applyStyle={s({ text: 'sm' })}>Anchored popover content. Click outside to dismiss.</div>
			</Popover>

			<Tooltip text="Native anchored tooltip" side="top">
				<Button variant="soft" size="small" label="Tooltip" />
			</Tooltip>

			<HoverCard side="bottom" align="start">
				{#snippet trigger()}<Button variant="soft" size="small" label="HoverCard" />{/snippet}
				<div use:applyStyle={s({ row: true, gap: 'md', items: 'center' })}>
					<Avatar fallback="Ada Lovelace" />
					<div use:applyStyle={s({ col: true, gap: 'micro' })}>
						<div use:applyStyle={s({ fontW: 600, text: 'sm' })}>Ada Lovelace</div>
						<div use:applyStyle={s({ text: 'xs', fg: 'neutral-readable' })}>First programmer</div>
					</div>
				</div>
			</HoverCard>

			<Menu items={menuItems}>
				{#snippet trigger()}<Button variant="soft" size="small" label="Menu ▾" />{/snippet}
			</Menu>

			<ContextMenu items={menuItems}>
				<div use:applyStyle={s({ p: 'xl', bg: 'surface-raised', radius: 'md', borderW: 1, border: 'neutral-muted', text: 'sm', fg: 'neutral-readable' })}>right-click me</div>
			</ContextMenu>
		</div>
		<div use:applyStyle={cap}>tooltip/hovercard: hover the button · menu: click · context menu: right-click the card</div>
	{/snippet}
</ComponentPage>
