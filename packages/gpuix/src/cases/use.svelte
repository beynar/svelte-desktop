<script>
	let tag = $state('none');
	function act(el, arg) { el.setAttribute('data-x', arg); return { update(a) { tag = 'upd:' + a; } }; }
	let arg = $state('one');
</script>
<div><span use:act={arg} onclick={() => (arg = 'two')}>tag={tag}</span></div>
