<script lang="ts">
	import { resolve } from '$app/paths';
	import { addNote, getState, increment, openNativeDialog } from '#lib/data.remote';
</script>

<h1>SvelteKit 3 + Bun, embedded</h1>

<svelte:boundary>
	{@const state = await getState()}

	<p>
		Server: <code>{state.runtime}</code> (pid {state.pid}) — counter in
		<code>bun:sqlite</code>: <strong>{state.counter}</strong>
	</p>
	<p>
		Host: <code>{state.host}</code> — native bridge:
		<strong>{state.nativeBridge ? 'connected' : 'absent'}</strong>
	</p>
	<button onclick={() => increment()}>increment via command()</button>
	<button onclick={() => openNativeDialog()}>native dialog via command()</button>

	<h2>Notes</h2>
	<form {...addNote}>
		<input {...addNote.fields.text.as('text')} placeholder="write a note" />
		<button>add via form()</button>
	</form>
	<ul>
		{#each state.notes as note (note.id)}
			<li>{note.text} <small>{note.created_at}</small></li>
		{/each}
	</ul>

	{#snippet pending()}
		<p>loading remote state…</p>
	{/snippet}
</svelte:boundary>

<p><a href={resolve('/about')}>client-side navigation → /about</a></p>
