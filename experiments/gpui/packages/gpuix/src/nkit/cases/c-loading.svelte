<script>
	import Skeleton from '../Skeleton.svelte';
	import Spinner from '../Spinner.svelte';
	import Progress from '../Progress.svelte';
</script>
<div>
	<Skeleton style={{ w: 100, h: 16 }} />
	<Spinner />
	<Progress value={40} />
	<div>loading-mounted</div>
</div>
