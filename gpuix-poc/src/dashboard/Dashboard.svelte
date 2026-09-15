<script lang="ts">
	// dashboard stress test — real shadcn-svelte registry components (vendored)
	// + svelte-streamdown, all running against the fake DOM → gpuix pipeline
	import * as Sidebar from '../shadcn/sidebar/index.js';
	import * as Card from '../shadcn/card/index.js';
	import { Button } from '../shadcn/button/index.js';
	import { Separator } from '../shadcn/separator/index.js';
	import { Badge } from '../shadcn/badge/index.js';
	import { Streamdown, shadcnTheme } from '../vendor/svelte-streamdown/index.js';
	import { frameStats } from '../native';

	type View = 'overview' | 'docs' | 'settings';
	let view = $state<View>('overview');

	const items: { id: View; icon: string; label: string }[] = [
		{ id: 'overview', icon: '▣', label: 'Overview' },
		{ id: 'docs', icon: '≡', label: 'Release notes' },
		{ id: 'settings', icon: '◇', label: 'Settings' },
	];

	const stats = $state([
		{ label: 'FPS', value: '—', delta: 'measuring' },
		{ label: 'P90 frame time', value: '—', delta: 'measuring' },
		{ label: 'Native nodes', value: '1,847', delta: '+38' },
		{ label: 'Heap resident', value: '19 MB', delta: '-57%' },
	]);
	// live frame telemetry from the renderer's debug-overlay sampler. gpuix
	// paints on demand, so headline FPS = 1000/p90 (sustained capability);
	// the delta line keeps the honest painted-frames rate
	setInterval(() => {
		const s = frameStats();
		if (!s) return;
		stats[0] = {
			...stats[0],
			value: s.p90Ms ? String(Math.round(1000 / s.p90Ms)) : '—',
			delta: `${(s.currentMs ?? 0).toFixed(1)} ms · ${s.fps} paint/s`,
		};
		stats[1] = {
			...stats[1],
			value: `${(s.p90Ms ?? 0).toFixed(2)} ms`,
			delta: `p99 ${(s.p99Ms ?? 0).toFixed(1)} · max ${(s.maxMs ?? 0).toFixed(0)}`,
		};
	}, 1000);

	const DOCS: Record<View, string> = {
		overview: `## Renderer pipeline

Every DOM mutation becomes an **op** on the native stream:

- \`create\`/\`insert\`/\`remove\` shape the retained tree
- style props map onto \`taffy\` layout + paint
- events route back through hit-testing → Svelte

### Why it stays fast

1. ops are **batched per frame** — Svelte effects flush once
2. text nodes paint directly, no layout round-trip
3. subtrees under \`hidden\` skip work entirely

> "The fake DOM is the contract — everything else is a backend."`,
		docs: `## Release 4.2 — Native Runtime

This build focuses on **throughput under load**:

- [x] op-stream batching (single flush per frame)
- [x] per-level load caching with uses-tracking
- [x] remote functions through \`hooks.handle\`
- [ ] native window chrome controls

### Benchmarks

| Metric | Before | After |
| --- | ---: | ---: |
| frame time | 11.2 ms | **4.1 ms** |
| ops / second | 38k | **120k** |
| heap | 44 MB | **19 MB** |

\`\`\`ts
const app = mount(Dashboard, { target });
// remote fns run in-process — no serialization
const q = query(async () => db.listNotes());
\`\`\`

Inline code like \`invalidateAll()\` works, and so do
*emphasis*, **strong**, and [links](https://example.invalid).`,
		settings: `## Runtime flags

| Flag | Value | Effect |
| --- | --- | --- |
| \`--ops-batch\` | \`frame\` | coalesce mutations per frame |
| \`--renderer\` | \`gpuix\` | native backend |
| \`--kit-layer\` | \`on\` | in-process SvelteKit semantics |

### Notes

Toggling flags requires a **restart** — the renderer is
instantiated before the Svelte root mounts.`,
	};

	let md = $state('');
	let pos = $state(0);
	let doc_ = $derived(DOCS[view]);
	const CHUNK = 7;

	$effect(() => {
		// stream the active doc into streamdown — its whole selling point is
		// parsing *incomplete* markdown as it arrives
		doc_; // track doc change
		pos = 0;
		md = '';
		const iv = setInterval(() => {
			pos = Math.min(doc_.length, pos + CHUNK);
			md = doc_.slice(0, pos);
			if (pos >= doc_.length) clearInterval(iv);
		}, 40);
		return () => clearInterval(iv);
	});

	const titles: Record<View, string> = {
		overview: 'Overview',
		docs: 'Release notes',
		settings: 'Settings',
	};
</script>

<Sidebar.Provider>
	<Sidebar.Root>
		<Sidebar.Header>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton size="lg">
						<span class="logo"></span>
						<span class="brand">gpuix <strong>native</strong></span>
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Header>
		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>Platform</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items as it}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={view === it.id} onclick={() => (view = it.id)}>
									<span class="mi-icon">{it.icon}</span>
									<span>{it.label}</span>
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
			<Sidebar.Group>
				<Sidebar.GroupLabel>Runtime</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem><Sidebar.MenuBadge>45/45</Sidebar.MenuBadge></Sidebar.MenuItem>
						<Sidebar.MenuItem><Sidebar.MenuButton>gpuix backend</Sidebar.MenuButton></Sidebar.MenuItem>
						<Sidebar.MenuItem><Sidebar.MenuButton>kit layer: on</Sidebar.MenuButton></Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>
		<Sidebar.Footer>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton>
						<span class="mi-icon">◔</span><span>arnaud — admin</span>
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Footer>
	</Sidebar.Root>
	<Sidebar.Inset>
		<header class="topbar">
			<Sidebar.Trigger />
			<Separator orientation="vertical" class="top-sep" />
			<h1 class="page-title">{titles[view]}</h1>
			<Badge variant="outline">gpuix live</Badge>
		</header>
		<main class="content">
			{#if view === 'overview'}
				<div class="cards">
					{#each stats as s}
						<Card.Root class="stat-card">
							<Card.Header>
								<Card.Description>{s.label}</Card.Description>
								<Card.Title class="stat-value">{s.value}</Card.Title>
							</Card.Header>
							<Card.Content>
								<Badge variant="secondary">{s.delta}</Badge>
							</Card.Content>
						</Card.Root>
					{/each}
				</div>
			{/if}
			<div class="md-row">
				<Card.Root class="md-card">
					<Card.Header>
						<Card.Title>{titles[view]}</Card.Title>
						<Card.Description>svelte-streamdown → fake DOM {pos < doc_.length ? `· ${Math.round((pos / doc_.length) * 100)}%` : '· done'}</Card.Description>
					</Card.Header>
					<Card.Content class="md-body">
						<Streamdown content={md} theme={shadcnTheme} />
					</Card.Content>
				</Card.Root>
				<Card.Root class="md-card">
					<Card.Header>
						<Card.Title>{titles[view]}</Card.Title>
						<Card.Description>native &lt;markdown&gt; element · same source</Card.Description>
					</Card.Header>
					<Card.Content class="md-body">
						<markdown source={md} class="md-native" />
					</Card.Content>
				</Card.Root>
			</div>
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>

<style>
	.logo {
		display: inline-block;
		width: 18px;
		height: 18px;
		border-radius: 5px;
		background-color: #7c6cf6;
		margin-right: 8px;
	}
	.brand {
		font-size: 14px;
		color: #fafafa;
	}
	.mi-icon {
		display: inline-block;
		width: 18px;
		margin-right: 6px;
		color: #a1a1aa;
	}
	.topbar {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-bottom-width: 1px;
		border-bottom-color: #27272a;
	}
	.top-sep {
		width: 1px;
		height: 18px;
		background-color: #27272a;
	}
	.page-title {
		font-size: 15px;
		font-weight: 600;
		color: #fafafa;
		flex-grow: 1;
	}
	.content {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 16px;
	}
	.cards {
		display: flex;
		flex-direction: row;
		gap: 12px;
	}
	:global(.stat-card) {
		flex-grow: 1;
	}
	:global(.stat-value) {
		font-size: 24px;
	}
	:global(.md-body) {
		max-height: 520px;
	}
	.md-row {
		display: flex;
		flex-direction: row;
		gap: 12px;
	}
	:global(.md-card) {
		flex-grow: 1;
		flex-basis: 0;
		min-width: 0;
	}
	:global(.md-native) {
		flex-grow: 1;
		overflow-y: scroll;
	}
</style>
