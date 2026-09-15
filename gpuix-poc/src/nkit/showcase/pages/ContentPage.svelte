<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Markdown from '../../Markdown.svelte';
	import CodeBlock from '../../CodeBlock.svelte';
	import Diff from '../../Diff.svelte';
	import ScrollArea from '../../ScrollArea.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const md = `## Markdown — native element

One \`source\` prop, rendered entirely native-side: **bold**, *italic*, \`code\`.

- lists render natively
- zero DOM nodes per paragraph
`;
	const code = `fn main() {\n    let kit = "svelte → native";\n    println!("{}", kit);\n}`;
	const patch = `--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,4 @@\n import x from 'x';\n-const a = 1;\n+const a = 2;\n+const b = 'added';\n export { a };`;
	const tall = $derived(s({ col: true, gap: 'xs', p: 'md' }));
</script>

<ComponentPage title="Markdown / Code / Diff / ScrollArea" description="chunky native primitives — one prop carries the whole document">
	{#snippet demo()}
		<Markdown source={md} style={{ w: 420 }} />
		<CodeBlock {code} language="rust" style={{ w: 420 }} />
		<Diff {patch} style={{ w: 420 }} />
		<ScrollArea maxH={120} style={{ w: 420, bg: 'surface-recessed', radius: 'md', borderW: 1, border: 'neutral-muted' }}>
			<div use:applyStyle={tall}>
				{#each Array(30) as _, i}<div>scrollable row {i + 1}</div>{/each}
			</div>
		</ScrollArea>
	{/snippet}
</ComponentPage>
