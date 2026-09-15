<script>
	import View from './View.svelte';
	import Stack from './Stack.svelte';
	import Text from './Text.svelte';
	import Button from './Button.svelte';
	import Chip from './Chip.svelte';
	import Card from './Card.svelte';

	const colors = ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'];
	const variants = ['solid', 'outline', 'soft', 'ghost', 'link'];
	const sizes = ['small', 'normal', 'large'];

	let active = $state('Overview');
	const nav = ['Overview', 'Analytics', 'Reports', 'Settings'];

	const md = `## Native markdown

This is **one** \`setCustomProp\` — the whole document is one native element.

- no DOM nodes
- no ops per paragraph
- *native text layout*

\`\`\`ts
const cost = 'one prop';
\`\`\`
`;
</script>

<View tokens="flex flex-row bg-surface" style={{ width: 1180, height: 780 }}>
	<!-- sidebar -->
	<View tokens="flex flex-col gap-xs bg-surface-recessed border-r border-neutral-muted" style={{ width: 208, padding: 16 }}>
		<View tokens="px-md" style={{ paddingTop: 4, paddingBottom: 12 }}>
			<Text size="base" weight="semibold" color="neutral">svelai → gpuix</Text>
		</View>
		{#each nav as item}
			<Button
				variant={active === item ? 'soft' : 'ghost'}
				color={active === item ? 'primary' : 'neutral'}
				size="normal"
				fullWidth
				label={item}
				onclick={() => (active = item)}
				class="justify-start"
			/>
		{/each}
	</View>

	<!-- content -->
	<View tokens="flex-1 flex flex-col overflow-y-auto" style={{ padding: 32 }}>
		<Stack gap="xl">
			<Stack gap="xs">
				<Text size="2xl" weight="semibold" color="neutral">Native kit spike</Text>
				<Text size="sm" color="neutral-readable">svelai cva recipes → finite token table → gpuix StyleDesc. Zero CSS engine.</Text>
			</Stack>

			<Card title="Chips" description="chipTheme — solid / outline / soft across the color roles" variant="solid" density="normal">
				<Stack orientation="horizontal" gap="sm" wrap>
					{#each colors as c}
						<Chip color={c} variant="solid">{c}</Chip>
					{/each}
				</Stack>
				<Stack orientation="horizontal" gap="sm" wrap>
					{#each colors as c}
						<Chip color={c} variant="soft">{c}</Chip>
					{/each}
				</Stack>
				<Stack orientation="horizontal" gap="sm" wrap>
					{#each colors as c}
						<Chip color={c} variant="outline">{c}</Chip>
					{/each}
				</Stack>
			</Card>

			<Card title="Buttons" description="buttonTheme verbatim — every variant × color lands or is audited" variant="solid" density="normal">
				{#each variants as v}
					<Stack orientation="horizontal" gap="sm" align="center" wrap>
						<View tokens="w-16"><Text size="xs" color="neutral-readable">{v}</Text></View>
						{#each colors as c}
							<Button variant={v} color={c} label={c} />
						{/each}
					</Stack>
				{/each}
				<Stack orientation="horizontal" gap="sm" align="center">
					<View tokens="w-16"><Text size="xs" color="neutral-readable">sizes</Text></View>
					{#each sizes as s}
						<Button variant="solid" color="primary" size={s} label={s} />
					{/each}
					<Button variant="solid" color="danger" label="disabled" disabled />
				</Stack>
			</Card>

			<Card title="Native markdown" description="one source prop — the primitive-absorption proof" variant="solid" density="normal">
				<markdown source={md} />
			</Card>
		</Stack>
	</View>
</View>
