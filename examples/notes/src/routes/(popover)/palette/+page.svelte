<script lang="ts">
	// Spotlight-style command palette in a borderless panel (global hotkey).
	import PopoverContent from '@svelte-desktop/shell/platform/PopoverContent.svelte';
	import { broadcast, closePopover, windows } from '@svelte-desktop/shell/platform';
	import { app, theme } from '@svelte-desktop/shell/stores';

	const commands = [
		{ label: 'New note', run: async () => { await app.show(); await windows.focus(); await broadcast('focus-input'); } },
		{ label: 'Toggle dark mode', run: () => theme.set(theme.dark ? 'light' : 'dark') },
		{ label: 'Show Notes window', run: async () => { await app.show(); await windows.focus(); } },
		{ label: 'About Notes', run: () => app.aboutPanel() },
		{ label: 'Quit', run: () => app.quit() },
	];
	let query = $state('');
	let index = $state(0);
	const matches = $derived(commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())));
	let input: HTMLInputElement | undefined = $state();
	$effect(() => input?.focus());

	async function run(i: number) {
		const cmd = matches[i];
		if (!cmd) return;
		await closePopover();
		query = '';
		await cmd.run();
	}
	function keys(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') index = Math.min(index + 1, matches.length - 1);
		else if (e.key === 'ArrowUp') index = Math.max(index - 1, 0);
		else if (e.key === 'Enter') run(index);
		else return;
		e.preventDefault();
	}
</script>

<PopoverContent padding="10px">
	<input bind:this={input} bind:value={query} oninput={() => (index = 0)} onkeydown={keys} placeholder="Type a command…" style="font-size:16px; padding:10px 12px" />
	<ul>
		{#each matches as c, i (c.label)}
			<li>
				<button style="width:100%; text-align:left; margin-top:2px; background:{i === index ? 'AccentColor' : 'transparent'}; color:{i === index ? 'AccentColorText' : 'inherit'}" onmouseenter={() => (index = i)} onclick={() => run(i)}>{c.label}</button>
			</li>
		{/each}
	</ul>
</PopoverContent>
