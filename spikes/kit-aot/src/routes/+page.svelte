<script lang="ts">
	import { addNote, getState, increment } from '#lib/data.remote';
</script>

<h1>kit-aot spike: SSR home</h1>

<svelte:boundary>
	{@const state = await getState()}
	<div class="card">
		<p>Server runtime: <code>{state.runtime}</code></p>
		<p>Counter (bun:sqlite): <strong id="counter">{state.counter}</strong></p>
		<button onclick={() => increment()}>increment via command()</button>

		<h2>Notes</h2>
		<form {...addNote}>
			<input {...addNote.fields.text.as('text')} placeholder="write a note" />
			<button>add via form()</button>
		</form>
		<ul>
			{#each state.notes as note (note.id)}
				<li>{note.text}</li>
			{/each}
		</ul>
	</div>
</svelte:boundary>
