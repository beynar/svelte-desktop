<script>
	import Input from '../Input.svelte';
	import Field from '../Field.svelte';
	let v = $state('');
</script>
<Input placeholder="ph-in" bind:value={v} />
<Field label="field-l" hint="field-h"><Input value="in-field" /></Field>
<div>iv={v}</div>
