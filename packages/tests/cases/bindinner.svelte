<script>let h = $state('<span>inner-injected</span>');</script>
<div><div contenteditable bind:innerHTML={h}></div><span>done</span></div>
