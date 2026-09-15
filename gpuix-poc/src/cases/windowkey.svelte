<script>let k = $state('none');</script>
<svelte:window onkeydown={(e) => (k = 'key:' + (e.key ?? e.keyChar))} />
<div><span>{k}</span></div>
