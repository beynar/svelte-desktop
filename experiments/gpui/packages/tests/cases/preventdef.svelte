<script>let c = $state(false);</script>
<input type="checkbox" bind:checked={c} onclick={(e) => e.preventDefault()} />
<div>c={c}</div>
