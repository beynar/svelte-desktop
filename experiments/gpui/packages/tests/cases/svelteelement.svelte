<script>let tag = $state('div');</script>
<div><svelte:element this={tag} style="color: #00ff00">dyn-{tag}</svelte:element>
<button onclick={() => (tag = 'input')}>mk-input</button></div>
