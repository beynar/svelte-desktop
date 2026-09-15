<script>
	import { enhance } from '#kit';
	import { form } from '#remote';
	let { form: formProp } = $props();
	let enhanced = $state('');

	// kit-shaped remote form — spreads method/action/data-remote-form,
	// dispatches to the remote fn through the submit pipeline
	const rf = form((fd) => 'ok:' + fd.get('note'));
</script>

<div style="color: #e5e7eb">
	action — form:{formProp ? `${formProp.via ?? ''}:${formProp.saved ?? ''}${formProp.intent ?? ''}${formProp.problem ?? ''}` : 'none'} · rf:{rf.result ?? 'none'}
</div>

<form method="POST">
	<input name="note" value="default-note" />
	<button>submit default</button>
</form>

<form method="POST" action="?/named">
	<input name="note" value="named-note" />
	<button>submit named</button>
</form>

<form method="POST" action="?/bad">
	<button>submit bad</button>
</form>

<form method="POST" action="?/away">
	<button>submit away</button>
</form>

<form
	method="POST"
	action="?/named"
	use:enhance={({ formData }) => {
		enhanced = `enhanced:${formData.get('note')}`;
	}}
>
	<input name="note" value="enhanced-note" />
	<button>submit enhanced</button>
</form>

<form
	method="POST"
	action="?/named"
	use:enhance={() => async ({ update }) => {
		enhanced = 'enhanced-update';
		await update();
	}}
>
	<input name="note" value="upd-note" />
	<button>submit upd</button>
</form>

<form method="GET" action="/item/7">
	<input name="q" value="needle" />
	<button>submit get</button>
</form>

<form method="POST" action="?/intent">
	<input name="note" value="x" />
	<button name="intent" value="a">intent a</button>
	<button name="intent" value="b">intent b</button>
</form>

<form {...rf}>
	<input name="note" value="rf-note" />
	<button>submit remote</button>
</form>

<div style="color: #9ca3af">{enhanced}</div>
