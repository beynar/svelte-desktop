<script>
	import Markdown from '../Markdown.svelte';
	import CodeBlock from '../CodeBlock.svelte';
	import Diff from '../Diff.svelte';
</script>
<div style="width:300px">
	<Markdown source="## md-heading" />
	<CodeBlock code={'const codeMarker = 1;'} language="js" />
	<Diff patch={'--- a/f\n+++ b/f\n@@ -1 +1 @@\n-oldLine\n+newLine'} />
</div>
