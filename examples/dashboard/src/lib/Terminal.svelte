<!-- The user's shell, in the page: xterm.js draws it, src/websocket.ts (/terminal) runs it in a
     pseudo-terminal on the app's server. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import '@xterm/xterm/css/xterm.css';

	let el: HTMLDivElement;
	let status = $state('connecting…');

	onMount(() => {
		let disposed = false;
		let cleanup = () => {};
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
			if (disposed) return;
			const css = getComputedStyle(document.documentElement);
			const term = new Terminal({
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: 12,
				cursorBlink: true,
				theme: { background: css.getPropertyValue('--color-surface-recessed').trim() || '#111', foreground: css.getPropertyValue('--color-neutral').trim() || '#eee' }
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(el);
			fit.fit();
			const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/terminal?cols=${term.cols}&rows=${term.rows}`);
			ws.binaryType = 'arraybuffer';
			ws.onopen = () => (status = '');
			ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
			ws.onclose = () => (status = 'the shell exited');
			const input = term.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ input: data })));
			const resize = new ResizeObserver(() => {
				fit.fit();
				if (ws.readyState === 1) ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
			});
			resize.observe(el);
			cleanup = () => {
				resize.disconnect();
				input.dispose();
				ws.close();
				term.dispose();
			};
		})();
		return () => {
			disposed = true;
			cleanup();
		};
	});
</script>

<div class="bg-surface-recessed h-72 overflow-hidden rounded-md p-2" data-terminal>
	<div bind:this={el} class="h-full w-full"></div>
</div>
{#if status}<p class="text-neutral-readable text-xs" data-terminal-status>{status}</p>{/if}
