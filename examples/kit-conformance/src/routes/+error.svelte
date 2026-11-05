<script lang="ts">
	import { page } from '$app/state';
</script>

<h1 id="error-status">{page.status}</h1>
<p id="error-message">{page.error?.message}</p>
