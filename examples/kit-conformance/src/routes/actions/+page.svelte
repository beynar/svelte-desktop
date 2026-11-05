<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<p id="cookie-name">{data.name}</p>
<p id="form-result">{JSON.stringify(form ?? null)}</p>
<form method="POST" action="?/save" use:enhance id="save"><input name="name" /><button>save</button></form>
<form method="POST" action="?/echo" use:enhance id="echo"><input name="text" /><button>echo</button></form>
<form method="POST" action="?/invalid" use:enhance id="invalid"><button>invalid</button></form>
<form method="POST" action="?/go" use:enhance id="go"><button>go</button></form>
