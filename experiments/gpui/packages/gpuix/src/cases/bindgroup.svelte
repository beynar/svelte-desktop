<script>let g = $state('a');</script>
<div>
	<input type="radio" name="r" value="a" bind:group={g} />
	<input type="radio" name="r" value="b" bind:group={g} />
	<span>g={g}</span>
</div>
