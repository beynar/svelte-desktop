<!-- A sheet's page (Board → New board…): a route of the app, shown alone in a native sheet on the
     window. host.dialog.close(result) ends it — the board page's host.dialog.sheet() resolves with
     it; Escape or ⌘. cancel. -->
<script lang="ts">
	import { Button } from 'entasis/button';

	let name = $state('');
	const create = (e: SubmitEvent) => {
		e.preventDefault();
		if (name.trim()) void host.dialog.close({ name: name.trim() });
	};
</script>

<svelte:head><title>New board</title></svelte:head>

<form class="flex h-full flex-col gap-4" onsubmit={create}>
	<div>
		<h2 class="text-neutral text-base font-semibold">New board</h2>
		<p class="text-neutral-readable text-sm">A board for a project or a sprint, in a tab of its own.</p>
	</div>
	<label class="text-neutral flex flex-col gap-1.5 text-sm">
		Name
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="border-neutral-muted bg-surface-canvas focus:outline-primary h-8 rounded-md border px-2.5 outline-offset-1 focus:outline-2"
			bind:value={name}
			placeholder="Q3 launch"
			autofocus
		/>
	</label>
	<div class="mt-auto flex justify-end gap-2">
		<Button variant="outline" onclick={() => host.dialog.close()}>Cancel</Button>
		<Button type="submit" disabled={!name.trim()}>Create</Button>
	</div>
</form>
