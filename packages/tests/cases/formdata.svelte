<script>
	let out = $state('none');
	function go() {
		const fd = new FormData(document.querySelector('form'));
		fd.append('extra', 'E');
		out = [...fd.entries()].map(([k, v]) => `${k}=${v}`).join(',');
	}
</script>
<div>
	<form>
		<input name="a" value="1" />
		<input name="b" value="2" />
	</form>
	<button onclick={go}>collect</button>
	<span>{out}</span>
</div>
