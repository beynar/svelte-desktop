<script lang="ts">
	import { onMount } from 'svelte';
	import { onDesktopEvent } from '@svelte-desktop/shell/client';
	import Popover from '@svelte-desktop/shell/platform/Popover.svelte';
	import { addNote, getState, increment } from '#lib/data.remote';
	import {
		clearNotes,
		exportNotes,
		importNotes,
		openDocs,
		quitApp,
		setTitle,
		shellInfo
	} from '#lib/desktop.remote';

	let log = $state<string[]>([]);
	let input: HTMLInputElement | undefined = $state();
	let emojiButton: HTMLButtonElement | undefined = $state();
	let emojiOpen = $state(false);

	// Messages from popover routes (separate web views, same app).
	onMount(() => {
		const offs = [
			host.onBroadcast('notes-changed', () => getState().refresh()),
			host.onBroadcast<string>('emoji', (e) => {
				if (!input) return;
				input.value += e;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.focus();
			}),
			host.onBroadcast('focus-input', () => input?.focus()),
		];
		return () => offs.forEach((off) => off());
	});
	const note = (line: string) => (log = [line, ...log].slice(0, 8));

	onMount(() =>
		onDesktopEvent('*', (data, type) => {
			if (type === 'menu' && data === 'new-note') input?.focus();
			if (type === 'menu' && data === 'export') exportNotes().then((r) => note(`exported → ${r.saved}`));
			note(`${type} ${JSON.stringify(data)}`);
		})
	);
</script>

<h1>Notes</h1>

<svelte:boundary>
	{@const state = await getState()}
	{@const info = await shellInfo()}
	<div class="card">
		<p>
			Server runtime: <code>{state.runtime}</code>
			{#if info.desktop}· desktop shell · data in <code>{info.data}</code>{:else}· browser (vite dev){/if}
		</p>
		<p>Counter (bun:sqlite): <strong id="counter">{state.counter}</strong></p>
		<button onclick={() => increment()}>increment via command()</button>

		<h2>Notes</h2>
		<form {...addNote}>
			<input bind:this={input} {...addNote.fields.text.as('text')} placeholder="write a note (⌘N)" />
			<button type="button" bind:this={emojiButton} onclick={() => (emojiOpen = !emojiOpen)} title="Emoji">😀</button>
			<button>add via form()</button>
		</form>
		<ul>
			{#each state.notes as n (n.id)}
				<li>{n.text}</li>
			{/each}
		</ul>
	</div>

	{#if info.desktop}
		<div class="card">
			<h2>Native</h2>
			<div class="row">
				<button onclick={async () => note(`imported ${(await importNotes()).imported}`)}>Import…</button>
				<button onclick={async () => note(`exported → ${(await exportNotes()).saved}`)}>Export…</button>
				<button onclick={async () => note(`cleared: ${(await clearNotes()).cleared}`)}>Clear all…</button>
				<button onclick={() => setTitle(`Notes — ${new Date().toLocaleTimeString()}`)}>Set title</button>
				<button onclick={() => openDocs()}>Open docs (browser)</button>
				<a href="https://svelte.dev" target="_blank">external link</a>
				<button onclick={() => quitApp()}>Quit</button>
			</div>
			<h3>Permissions</h3>
			<div class="row" id="permissions">
				{#each Object.keys(host.permissions.declared()) as name (name)}
					<span>{name}: <b data-permission={name}>{host.permissions.get(name)}</b></span>
					{#if host.permissions.get(name) !== 'granted'}
						<button onclick={() => host.permissions.request(name)}>{host.permissions.settingsOnly(name) ? 'Guide me…' : 'Allow…'}</button>
					{/if}
				{/each}
			</div>
			<h3>Notifications</h3>
			<div class="row" id="notifications">
				<span>permission: <b id="notification-permission">{host.notifications.permission}</b></span>
				{#if host.notifications.permission === 'notDetermined'}
					<button onclick={() => host.notifications.requestPermission()}>Allow…</button>
				{/if}
				<button onclick={() => host.notifications.show({ id: 'hello', title: 'Svelte Notes', body: 'Click me: opens About', url: '/about' })}>Notify</button>
				<button onclick={() => host.notifications.show({ id: 'later', title: 'Reminder', body: 'Scheduled 5 s ago', delay: 5000 })}>In 5 s</button>
				<button onclick={() => host.notifications.show({
					id: 'chat', title: 'Alice', subtitle: '#general', body: 'Lunch?', group: 'chat',
					actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Message' } }, { id: 'about', title: 'Open About', url: '/about' }]
				})}>With actions</button>
				<span id="notification-response">{host.notifications.lastResponse ? `${host.notifications.lastResponse.kind} ${host.notifications.lastResponse.id}${host.notifications.lastResponse.input ? `: ${host.notifications.lastResponse.input}` : ''}` : ''}</span>
			</div>
			<h3>Background jobs</h3>
			<div class="row">
				<button id="start-job" onclick={() => fetch('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'count', args: { to: 40, delay: 50 } }) })}>Run a job</button>
				{#each host.jobs.active() as j (j.id)}
					<span class="job"><progress value={j.progress}></progress> {j.message ?? j.state}
						<button onclick={() => host.jobs.cancel(j.id)}>✕</button></span>
				{/each}
				<span id="jobs-done">{host.jobs.list().filter((j) => j.state === 'done').length} done</span>
			</div>
			<h3>Events</h3>
			<ul class="log">
				{#each log as line, i (i)}<li><code>{line}</code></li>{/each}
			</ul>
		</div>
	{/if}
</svelte:boundary>

<!-- Anchored to the 😀 button: the arrow points at it. -->
<Popover route="/emoji" anchor={emojiButton} bind:open={emojiOpen} width={260} height={120} />

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.log {
		font-size: 0.8rem;
		opacity: 0.8;
	}
</style>
