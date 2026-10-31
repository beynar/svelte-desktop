<script lang="ts">
	// Opened from the menu-bar icon. Same server, same remote functions and
	// session as the main window; `broadcast` tells the window to refresh.
	import PopoverContent from '@svelte-desktop/shell/platform/PopoverContent.svelte';
	import { broadcast, closePopover } from '@svelte-desktop/shell/platform';
	import { app, theme } from '@svelte-desktop/shell/stores';
	import { addNote, getState } from '#lib/data.remote';

	let input: HTMLInputElement | undefined = $state();
	$effect(() => input?.focus());
</script>

<PopoverContent>
	<h3>Quick note</h3>
	<form
		{...addNote.enhance(async ({ form, submit }) => {
			await submit();
			form.reset();
			await broadcast('notes-changed');
		})}
	>
		<input bind:this={input} {...addNote.fields.text.as('text')} placeholder="Write and press ↩" />
	</form>
	<svelte:boundary>
		{@const state = await getState()}
		<ul>
			{#each state.notes.slice(0, 5) as n (n.id)}<li>• {n.text}</li>{/each}
		</ul>
		<p class="muted">{state.notes.length} notes · {theme.dark ? 'dark' : 'light'} · {app.name ?? ''}</p>
	</svelte:boundary>
	<div style="display:flex; gap:6px; justify-content:flex-end; margin-top:8px">
		<button onclick={() => app.show()}>Open Notes</button>
		<button onclick={() => closePopover()}>Done</button>
	</div>
</PopoverContent>
