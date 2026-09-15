<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Dialog from '../../Dialog.svelte';
	import Button from '../../Button.svelte';
	import { toast } from '../../Toaster.svelte';
	import Toaster from '../../Toaster.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' }];
	let open = $state(false);
	const row = $derived(s({ row: true, gap: 'sm' }));
</script>

<ComponentPage title="Dialog / Toast" description="modal scrim + escape/outside dismiss; toasts stack bottom-right" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={row}>
			<Button variant="solid" label="Open dialog" onclick={() => (open = true)} />
			<Button variant="soft" color="success" label="Success toast" onclick={() => toast('Saved successfully', { color: 'success', title: 'Done' })} />
			<Button variant="soft" color="danger" label="Error toast" onclick={() => toast('Something failed', { color: 'danger' })} />
			<Button variant="soft" label="Plain toast" onclick={() => toast('Just a message')} />
		</div>
		<Dialog bind:open title="Delete project?" description="This cannot be undone. All files will be removed." size={p.size}>
			{#snippet footer()}
				<Button variant="ghost" label="Cancel" onclick={() => (open = false)} />
				<Button variant="solid" color="danger" label="Delete" onclick={() => { open = false; toast('Project deleted', { color: 'danger' }); }} />
			{/snippet}
		</Dialog>
		<Toaster />
	{/snippet}
</ComponentPage>
