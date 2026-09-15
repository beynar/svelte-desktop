<script>
	import Theme from '../Theme.svelte';
	import Button from '../Button.svelte';
	import Chip from '../Chip.svelte';
</script>

<!-- Theme provides: registry defaults (button size=large), defaultColor,
     resolvedTheme/systemTheme state to children, live theme switching. -->
<Theme
	defaultTheme="dark"
	defaultColor="primary"
	components={{ button: { size: 'large' }, chip: { root: { base: { radius: 'full' } } } }}
>
	{#snippet children(th)}
		<div>th={th.resolvedTheme} sys={th.systemTheme} dc={th.defaultColor} bp={th.currentBreakpoint} rm={th.preferReducesMotion}</div>
		<Button label="big-btn" onclick={() => (th.theme = 'light')} />
		<Chip label="themed-chip" />
		<Chip label="inst-chip" theme={{ root: { base: { borderW: 2 } } }} />
	{/snippet}
</Theme>
