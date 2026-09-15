<script>let el = $state(); let tag = $state('?');</script>
<div><span bind:this={el}>x</span><button onclick={() => (tag = el?.tagName ?? 'null')}>show</button><span>tag={tag}</span></div>
