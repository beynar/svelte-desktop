<script>let s = $state(0);</script>
<div style="height: 60px; overflow: scroll" onscroll={(e) => (s = e.target.scrollTop)}>
	<div style="height: 400px">tall</div>
	<span>scrolled={s}</span>
</div>
