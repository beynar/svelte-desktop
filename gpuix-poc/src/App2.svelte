<script lang="ts">
	let text = $state('');
	let clicks = $state(0);

	function autofocus(el: HTMLElement) {
		el.focus();
	}
</script>

<div style="display: flex; flexDirection: column; padding: 24px; gap: 12px; backgroundColor: #0f1115; height: 600px">
	<input
		style="backgroundColor: #1f2937; color: #e5e7eb; padding: 8px; borderRadius: 6px"
		placeholder="type here"
		use:autofocus
		oninput={(e) => (text = (e.target as HTMLInputElement).value)}
	/>
	<div style="color: #9ca3af; fontSize: 14px">you typed: {text}</div>
	<div
		style="backgroundColor: #3b82f6; borderRadius: 8px; padding: 12px; color: #ffffff"
		onclick={() => clicks++}
	>
		clicks: {clicks}
	</div>
</div>
