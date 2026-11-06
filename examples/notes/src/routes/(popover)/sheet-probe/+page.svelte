<script lang="ts">
	// A route shown as a dialog, under test only (tests/windows-desktop.test.ts). Its two buttons fill the top of the
	// page, so real clicks find them.
	let { data } = $props();
	let typed = $state('');
	const close = () => host.dialog.close({ typed, header: data.header, view: (globalThis as { __desktopView?: string }).__desktopView, title: document.title });
</script>

<svelte:head><title>{data.title}</title></svelte:head>
<button style="position:fixed; left:0; top:0; width:50%; height:100px" onclick={close}>Confirm</button>
<button style="position:fixed; left:50%; top:0; width:50%; height:100px" onclick={() => host.dialog.close()}>Cancel</button>
<!-- svelte-ignore a11y_autofocus -->
<input style="position:fixed; left:0; top:110px; width:100%" bind:value={typed} autofocus />
