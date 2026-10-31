<script lang="ts">
	// Opened from the menu-bar icon. Same server, same remote functions and
	// session as the main window; `host.broadcast` tells the window to refresh.
	import PopoverContent from '@svelte-desktop/shell/platform/PopoverContent.svelte';
	import { addNote, getState } from '#lib/data.remote';

	let input: HTMLInputElement | undefined = $state();
	$effect(() => input?.focus());
</script>

<PopoverContent>
	<h3>Quick note</h3>
	<form
		{...addNote.enhance(async (form) => {
			await form.submit();
			form.element.reset();
			await host.broadcast('notes-changed');
		})}
	>
		<input bind:this={input} {...addNote.fields.text.as('text')} placeholder="Write and press ↩" />
	</form>
	<svelte:boundary>
		{@const state = await getState()}
		<ul>
			{#each state.notes.slice(0, 5) as n (n.id)}<li>• {n.text}</li>{/each}
		</ul>
		<p class="muted">{state.notes.length} notes · {host.theme.dark ? 'dark' : 'light'} · {host.app.name ?? ''}</p>
	</svelte:boundary>
	<div style="display:flex; gap:6px; justify-content:flex-end; margin-top:8px">
		<button onclick={() => host.app.show()}>Open Notes</button>
		<button onclick={() => host.closePopover()}>Done</button>
	</div>
</PopoverContent>
