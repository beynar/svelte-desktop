<script>let m = $state('<b>old-html</b>');</script>
<button onclick={() => (m = '<b>new-html</b>')}>swap-html</button>
<div>{@html m}</div>
