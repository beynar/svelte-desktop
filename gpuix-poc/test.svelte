<script>
	let count = $state(0);
</script>

<div class="box" style="padding: 16px">
	<button onclick={() => count++}>inc</button>
	<p>count: {count}</p>
</div>
