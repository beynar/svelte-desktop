<script>let p = new Promise(r => setTimeout(() => r('RESOLVED'), 20));</script>
<div>{#await p}<span>loading</span>{:then v}<span>{v}</span>{/await}</div>
