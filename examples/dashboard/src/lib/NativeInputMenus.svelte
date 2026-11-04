<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	let lines = $state<string[]>([]);
	let intercept = $state(false);
	let inputTouched = false;
	const note = (line: string) => lines = [line, ...lines].slice(0, 8);
	async function run(action: () => Promise<unknown>) {
		try { await action(); } catch (e) { note((e as Error).message); }
	}
	const choices = [
		{ id: 'native-mode-write', label: 'Write', type: 'radio' as const, group: 'mode', checked: true },
		{ id: 'native-mode-read', label: 'Read', type: 'radio' as const, group: 'mode', tooltip: 'Read mode' },
	];
	async function toggleInput() {
		inputTouched = true;
		const next = !intercept;
		const state = await host.webview.setInputPolicy({ intercept: next ? [{ key: 'k', modifiers: ['meta', 'shift'] }] : [] });
		intercept = next;
		note(`Native monitor ${state.monitorInstalled ? 'installed' : 'unavailable'}; ${state.interceptCount} shortcuts`);
	}
	async function editorFocus(focused: boolean) {
		inputTouched = true;
		await host.webview.setInputPolicy({ intercept: intercept ? [{ key: 'k', modifiers: ['meta', 'shift'] }] : [], menuShortcuts: !focused });
		note(focused ? 'Editor focused: menu shortcuts off' : 'Menu shortcuts restored');
	}
	async function radio() {
		await host.menu.insert({ name: 'Demo Mode', items: choices });
		await host.menu.update({ id: 'native-mode-read', checked: true });
		const a = await host.menu.get('native-mode-write'), b = await host.menu.get('native-mode-read');
		note(`Exclusive selection: Write=${a?.checked}, Read=${b?.checked}`);
	}
	async function copy() {
		const result = await host.clipboard.write({ text: 'Dashboard copy', html: '<b>Dashboard copy</b>', formats: { 'com.svelte-desktop.dashboard': btoa('native-copy') } });
		const data = await host.clipboard.read({ formats: ['text/plain', 'text/html', 'com.svelte-desktop.dashboard'] });
		note(`Copy #${result.changeCount}: ${result.changeCount - result.previousChangeCount} ownership change, ${Object.keys(data.formats).length} representations; ${atob(data.formats['com.svelte-desktop.dashboard'] ?? '')}`);
	}
	onMount(() => {
		const offs = [
			host.webview.onBeforeInput((event) => note(`${event.type}: ${event.key} (native interception)`)),
			host.menu.onWillShow('native-context', () => note('Context menu opened')),
			host.menu.onDidClose('native-context', () => note('Context menu closed')),
		];
		return () => {
			offs.forEach((off) => off());
			if (inputTouched) void host.webview.setInputPolicy({});
			void host.menu.remove('Demo Mode');
		};
	});
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Native input</h2>
	<p class="text-neutral-readable text-sm">Claim Command+Shift+K before WebKit and the menus. The callback arrives asynchronously. Focus the editor to temporarily turn off menu shortcuts.</p>
	<Button variant="outline" onclick={() => run(toggleInput)}>{intercept ? 'Release shortcut' : 'Intercept shortcut'}</Button>
	<input aria-label="Input policy editor" placeholder="Focus to disable menu shortcuts" class="border-neutral-muted rounded-md border p-2" onfocus={() => run(() => editorFocus(true))} onblur={() => run(() => editorFocus(false))} />
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Menus and radio groups</h2>
	<p class="text-neutral-readable text-sm">Exclusive selection stays native across updates. Context menu open and close events appear below.</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" onclick={() => run(radio)}>Select Read in menu bar</Button>
		<Button variant="outline" onclick={() => run(() => host.menu.popup({ id: 'native-context', items: choices }))}>Open context menu</Button>
	</div>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Multi-format clipboard</h2>
	<p class="text-neutral-readable text-sm">One copy publishes plain text, HTML and a custom binary format together.</p>
	<Button variant="outline" onclick={() => run(copy)}>Copy and read three formats</Button>
	{#if lines.length}<pre class="text-neutral-readable whitespace-pre-wrap text-xs">{lines.join('\n')}</pre>{/if}
</section>
