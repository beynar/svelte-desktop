<!-- Light / dark, in the title bar. The window's own appearance follows the page's theme — its
     traffic lights, menus, dialogs and vibrancy material — so a light page never sits in a dark
     window. In a tab, entasis's <Theme> stores the choice: every window and tab picks it up. -->
<script lang="ts">
	import { useTheme } from 'entasis/theme';
	import { moonIcon } from 'entasis/icons/moon';
	import { sunIcon } from 'entasis/icons/sun';

	const theme = useTheme();
	const dark = $derived(theme.resolvedTheme === 'dark');

	$effect(() => {
		// 'system' leaves the window to the OS, so it follows its changes live.
		void host.window.setTheme(theme.theme === 'system' ? 'system' : dark ? 'dark' : 'light').catch(() => {});
	});
</script>

<button
	type="button"
	class="state-layer text-neutral-readable hover:text-neutral mb-1 grid size-8 shrink-0 place-items-center rounded-md"
	aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
	title={dark ? 'Light mode' : 'Dark mode'}
	data-theme-toggle
	onclick={() => (theme.theme = dark ? 'light' : 'dark')}
>
	{@render (dark ? sunIcon : moonIcon)({ class: 'size-4' })}
</button>
