<script>
	let s = $state('no');
	const act = (node) => {
		node.addEventListener('ping', (e) => {
			s = e.currentTarget === node && e.target === node ? 'ok' : 'bad';
		});
		node.dispatchEvent(new Event('ping'));
	};
</script>
<div use:act>ct={s}</div>
