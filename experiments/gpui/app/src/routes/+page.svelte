<script lang="ts">
	import {
		addNote,
		addQuickNote,
		deleteNote,
		getState,
		increment,
		openNativeDialog
	} from '#lib/data.remote';
	import MenuBar from '@svelte-desktop/platform/gen/components/MenuBar.js';
	import StatusItem from '@svelte-desktop/platform/gen/components/StatusItem.js';
	import Icon from '@svelte-desktop/gpuix/gen/nkit/Icon.js';
	import { scale } from 'svelte/transition';
	const fmt = (iso: string) => iso.slice(5, 16).replace('T', ' · ');
	let input = $state("")
	let count = $state(0)
	let popoverOpen = $state(false)
	// dev-loop path — vite dev runs with cwd=app/. Packaged builds would
	// resolve this from the bundle resources.
	const trayIcon = `${process.cwd()}/src/lib/assets/tray.png`;
</script>

<MenuBar
	label="Notes"
	items={[
		{ label: 'Quick Note', icon: 'add', onClick: () => addQuickNote(`quick · ${new Date().toLocaleTimeString()}`) },
		{ label: 'Increment', icon: 'statusavailable', onClick: () => increment() },
		'separator',
		{
			label: 'App',
			subItems: [
				{ label: 'About', role: 'about' },
				{ label: 'Hide', role: 'hide' },
				{ label: 'Quit', role: 'quit' },
			],
		},
	]}
/>

<div class="page">
{input} {count}
	<svelte:boundary>
		{@const state = await getState()}

		<StatusItem
			icon={trayIcon}
			label=""
			tooltip="svelte·desktop notes"
			badgeColor={state.notes.length ? '#ff3b30' : null}
			bind:open={popoverOpen}
			position={({ width, height, displays }) => {
				// Spotlight-style: bottom-center of the window's screen.
				const wa = displays[0].workArea;
				return { x: wa.x + (wa.width - width) / 2, y: wa.y + wa.height - height - 96 };
			}}
		>
			<div class="popover" in:scale={{ duration: 200 }}>
				<div class="popover-title">{state.notes.length} notes</div>
				<div class="popover-sub">counter · {state.counter}</div>
				<div class="popover-actions">
					<button class="btn" onclick={() => addQuickNote(`tray · ${new Date().toLocaleTimeString()}`)}>+ note</button>
					<button class="btn" onclick={() => increment()}>++</button>
				</div>
			</div>
		</StatusItem>

		<header class="page-head">
			<div class="head-text">
				<h1 class="title">Notes</h1>
				<p class="subtitle">
					{state.notes.length} notes · persisted in bun:sqlite
				</p>
				<button class="btn" onclick={() => count++}>
					count: {count}
				</button>
			</div>
			<div class="head-actions">
				<button class="btn" onclick={() => increment()}>
					counter · {state.counter}
				</button>
				<button class="btn" onclick={() => openNativeDialog()}>
					native dialog 
				</button>
			</div>
		</header>

		<form class="composer" {...addNote}>
			<input
				class="composer-input"
				name="text"
				bind:value={input}
				placeholder="Write a note…"
			/>
			<button class="btn primary">Add note </button>
		</form>

		<div class="notes">
			{#each state.notes as note (note.id)}
				<div class="note">
					<div class="note-body">
						<div class="note-text">{note.text}</div>
						<div class="note-time">{fmt(note.created_at)}</div>
					</div>
					<button
						class="note-del"
						aria-label="delete note"
						onclick={() => deleteNote(note.id)}
					>
						<Icon name="x" size={16} class="note-del-ic" />
					</button>
				</div>
			{:else}
				<div class="empty">
					<div class="empty-title">No notes yet</div>
					<div class="empty-sub">
						Write one above — it lands in sqlite through a remote
						function, no HTTP anywhere.
					</div>
				</div>
			{/each}
		</div>

		{#snippet pending()}
			<p class="loading">loading remote state…</p>
		{/snippet}
	</svelte:boundary>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 26px 30px;
		gap: 16px;
		min-height: 0;
	}
	.page-head {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.title {
		font-size: 24px;
		font-weight: 700;
	}
	.subtitle {
		font-size: 12px;
		color: #8e8e96;
	}
	.head-actions {
		display: flex;
		flex-direction: row;
		gap: 8px;
	}
	.btn {
		padding: 7px 14px;
		border-radius: 7px;
		background-color: #35353d;
		border-width: 1px;
		border-color: #45454e;
		color: #e8e8ec;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		user-select: none;
	}
	.btn:hover {
		background-color: #404049;
		border-color: #55555f;
	}
	.btn:active {
		background-color: #2c2c33;
	}
	.btn.primary {
		background-color: #0a84ff;
		border-color: #0a84ff;
		color: #ffffff;
	}
	.btn.primary:hover {
		background-color: #2b95ff;
		border-color: #2b95ff;
	}
	.btn.primary:active {
		background-color: #0873e0;
	}
	.composer {
		display: flex;
		flex-direction: row;
		gap: 8px;
	}
	.composer-input {
		flex: 1;
		padding: 9px 12px;
		border-radius: 8px;
		background-color: #26262c;
		border-width: 1px;
		border-color: #3a3a42;
		color: #f2f2f7;
		font-size: 13px;
	}
	.composer-input:focus {
		border-color: #0a84ff;
	}
	.notes {
		display: flex;
		flex-direction: column;
		gap: 8px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding: 2px;
	}
	.note {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-radius: 10px;
		background-color: #292930;
		border-width: 1px;
		border-color: #37373f;
	}
	.note:hover {
		background-color: #303038;
		border-color: #42424b;
	}
	.note-body {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 1;
		min-width: 0;
	}
	.note-text {
		font-size: 13px;
		color: #f0f0f4;
	}
	.note-time {
		font-size: 10px;
		color: #6e6e76;
	}
	.note-del {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		cursor: pointer;
		user-select: none;
	}
	.note-del:hover {
		background-color: #453a3a;
	}
	.note-del-ic {
		color: #6e6e76;
	}
	.note-del:hover .note-del-ic {
		color: #ff6961;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 48px 20px;
		border-radius: 10px;
		border-width: 1px;
		border-color: #33333b;
	}
	.empty-title {
		font-size: 14px;
		font-weight: 600;
		color: #b8b8c0;
	}
	.empty-sub {
		font-size: 12px;
		color: #6e6e76;
		text-align: center;
	}
	.loading {
		font-size: 13px;
		color: #8e8e96;
	}
	.popover {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border-radius: 10px;
		background-color: #26262d;
		border-width: 1px;
		border-color: #3c3c45;
	}
	.popover-title {
		font-size: 13px;
		font-weight: 600;
		color: #f0f0f4;
	}
	.popover-sub {
		font-size: 11px;
		color: #8e8e96;
	}
	.popover-actions {
		display: flex;
		flex-direction: row;
		gap: 6px;
	}
</style>
