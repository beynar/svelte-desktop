<script>
	import Toaster, { toast } from '../Toaster.svelte';
</script>
<button onclick={() => toast('toast-msg', { title: 'toast-t', duration: 60000 })}>mk-toast</button>
<Toaster />
