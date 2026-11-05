<!-- The app's own native modules, one per language, all called the same way: host.native.<service>.<op>()
     — typed from each language (src/native.d.ts, written by the build from native/). -->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import type { AIAvailability } from '@kitop/shell/ai';
	import Terminal from '#lib/Terminal.svelte';

	let { data } = $props();

	const ms = (t: number) => `${Math.max(1, Math.round(performance.now() - t))} ms`;
	const message = (e: unknown) => (e as Error).message;

	// --- Python + numpy: a trend over the last 30 days of closed tickets, and the week ahead.
	// The series is made up (seeded), so it's the same on every launch.
	const history = Array.from({ length: 30 }, (_, i) => {
		const noise = Math.sin(i * 12.9898) * 43758.5453;
		return Math.max(2, Math.round(14 + 0.45 * i + 5 * Math.sin(i / 2.2) + 6 * (noise - Math.floor(noise) - 0.5)));
	});
	let forecast = $state<Awaited<ReturnType<typeof host.native.forecast.trend>> | null>(null);
	let runtime = $state<{ pid: number; python: string; numpy: string } | null>(null);
	let previousPid = $state<number | null>(null);
	let pyStatus = $state('');
	let pyBusy = $state(false);
	async function trend() {
		pyBusy = true;
		const t = performance.now();
		try {
			forecast = await host.native.forecast.trend({ values: history, horizon: 7 });
			pyStatus = `forecast in ${ms(t)}`;
		} catch (e) {
			pyStatus = message(e);
		} finally {
			pyBusy = false;
		}
	}
	async function crash() {
		pyBusy = true;
		previousPid = runtime?.pid ?? null;
		try {
			await host.native.forecast.crash();
		} catch (e) {
			pyStatus = `crash: ${message(e)}`;
		}
		// The next call starts a new process.
		const t = performance.now();
		runtime = await host.native.forecast.runtime().catch(() => null);
		pyStatus += ` — new process ready in ${ms(t)}`;
		pyBusy = false;
	}
	const scale = $derived(Math.max(...history, ...(forecast?.high ?? [])) || 1);

	// --- Rust: a file's SHA-256, read in 1 MB chunks on a thread of its own, with progress events.
	let file = $state<{ name: string; hex?: string; bytes?: number; millis?: number } | null>(null);
	let progress = $state<{ bytes: number; total: number } | null>(null);
	let rustStatus = $state('');
	let requestId = '';
	let offProgress: (() => void) | undefined;
	onMount(() => {
		offProgress = host.on<{ requestId: string; bytes: number; total: number }>('files.progress', (p) => {
			if (p.requestId === requestId) progress = { bytes: p.bytes, total: p.total };
		});
	});
	onDestroy(() => offProgress?.());
	async function checksum() {
		const picked = await host.dialog.showOpenDialog({ prompt: 'Checksum' });
		const path = picked.paths[0];
		if (picked.canceled || !path) return;
		requestId = crypto.randomUUID();
		file = { name: path.split('/').pop() ?? path };
		progress = { bytes: 0, total: 0 };
		rustStatus = '';
		try {
			file = { ...file, ...(await host.native.files.sha256({ path, requestId })) };
		} catch (e) {
			rustStatus = message(e);
		}
	}
	const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

	// --- Swift: Apple's on-device NaturalLanguage — the language, the tone, the nouns.
	let text = $state('Le lancement de la facturation s’est très bien passé : les clients adorent le nouveau tableau de bord.');
	let analysis = $state<Awaited<ReturnType<typeof host.native.language.analyze>> | null>(null);
	let swiftStatus = $state('');
	async function analyze() {
		const t = performance.now();
		try {
			analysis = await host.native.language.analyze({ text });
			swiftStatus = `analyzed in ${ms(t)}`;
		} catch (e) {
			swiftStatus = message(e);
		}
	}
	const languageName = (code?: string | null) => (code ? (new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code) : 'not sure');
	const tone = (s: number) => (s > 0.25 ? 'positive' : s < -0.25 ? 'negative' : 'neutral');

	// --- The system's on-device model (host.ai: Apple's, macOS 26 with Apple Intelligence on).
	let aiState = $state<AIAvailability | null>(null);
	let aiPrompt = $state('Summarize in one sentence: the billing migration moved every invoice to the new provider over the weekend, customers saw no downtime, and two edge cases with refunds remain open.');
	let aiOut = $state('');
	let aiTask = $state<{ title: string; owner: string | null; priority: string; due: string | null } | null>(null);
	let aiStatus = $state('');
	let aiBusy = $state(false);
	const reasons: Record<string, string> = {
		appleIntelligenceNotEnabled: 'Apple Intelligence is off: System Settings › Apple Intelligence & Siri.',
		deviceNotEligible: 'This Mac can’t run Apple’s model.',
		modelNotReady: 'The model is still downloading — try again in a while.',
		unsupported: 'No on-device model here (it needs macOS 26).'
	};
	async function ask() {
		aiBusy = true;
		aiOut = '';
		const t = performance.now();
		try {
			for await (const piece of host.ai.stream(aiPrompt)) aiOut += piece;
			aiStatus = `streamed in ${ms(t)}`;
		} catch (e) {
			aiStatus = message(e);
		} finally {
			aiBusy = false;
		}
	}
	async function extract() {
		aiBusy = true;
		const t = performance.now();
		try {
			aiTask = await host.ai.generate(`Extract the task from this message: “Sam, can you call the Acme team by Friday about the Q4 renewal? It’s urgent.”`, {
				schema: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'What to do, in a few words' },
						owner: { type: ['string', 'null'], description: 'Who should do it' },
						priority: { enum: ['low', 'medium', 'high'] },
						due: { type: ['string', 'null'], description: 'When, as written' }
					},
					required: ['title', 'priority']
				}
			});
			aiStatus = `extracted in ${ms(t)}`;
		} catch (e) {
			aiStatus = message(e);
		} finally {
			aiBusy = false;
		}
	}

	// --- The app's command in the terminal (desktop.config `command`).
	let cmd = $state<{ name: string | null; available: boolean; path: string | null; onPath: boolean; error?: string } | null>(null);
	const commandCall = async (method: 'GET' | 'POST' | 'DELETE') => {
		const r = await (await fetch('/modules/command', { method })).json();
		cmd = method === 'POST' ? { ...(cmd ?? { name: null, available: true, path: null, onPath: false }), ...('error' in r ? { error: r.error } : { path: r.path, onPath: r.onPath, error: undefined }) } : r;
	};

	onMount(() => {
		void commandCall('GET');
		void host.ai.availability().then((a) => (aiState = a));
		void trend();
		void host.native.forecast.runtime().then((r) => (runtime = r), () => {});
		void analyze();
	});
</script>

<svelte:head><title>Modules</title></svelte:head>

{#snippet header(title: string, language: string, where: string)}
	<div class="flex items-start justify-between gap-3">
		<h2 class="text-neutral text-base font-semibold">{title}</h2>
		<span class="bg-surface-recessed text-neutral-readable shrink-0 rounded-md px-2 py-0.5 text-xs font-medium">{language}</span>
	</div>
	<p class="text-neutral-readable -mt-1 text-xs">{where}</p>
{/snippet}

<div class="flex max-w-5xl flex-col gap-4 p-6">
	<p class="text-neutral-readable max-w-3xl text-sm">
		Your own code, in the language that has the library you need. Each module lives in <code>native/</code>, and every
		command is called the same way from a page or from server code: <code>host.native.service.op(args)</code>, typed from
		its language. Where it runs differs — that's what each card shows.
	</p>

	<div class="grid gap-4 md:grid-cols-2">
		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4 md:col-span-2" data-module="python">
			{@render header('Ticket forecast', 'Python · numpy', 'native/python/forecast.py — in a Python process of the app’s own: a crash there never takes the window down')}
			<div class="flex h-36 items-end gap-[3px]" aria-label="Closed tickets per day, then the forecast">
				{#each history as v, i (i)}
					<div class="bg-primary/70 flex-1 rounded-t-sm" style:height="{(v / scale) * 100}%" title="Day {i + 1}: {v}"></div>
				{/each}
				{#each forecast?.forecast ?? [] as v, i (i)}
					<div class="relative flex-1" style:height="100%" title="Day {history.length + i + 1}: ~{Math.round(v)}">
						<div class="bg-primary/15 absolute inset-x-0 rounded-sm" style:bottom="{(forecast!.low[i]! / scale) * 100}%" style:height="{((forecast!.high[i]! - forecast!.low[i]!) / scale) * 100}%"></div>
						<div class="bg-primary/40 absolute inset-x-0 bottom-0 rounded-t-sm" style:height="{(v / scale) * 100}%"></div>
					</div>
				{/each}
			</div>
			{#if forecast}
				<p class="text-neutral text-sm" data-forecast>
					{forecast.slope >= 0 ? '+' : ''}{forecast.slope.toFixed(2)} tickets a day · next week ≈ {Math.round(forecast.forecast.reduce((a, b) => a + b, 0))} tickets
					<span class="text-neutral-readable">(R² {forecast.r2.toFixed(2)}, shaded: where 95% of days fall)</span>
				</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="small" disabled={pyBusy} onclick={trend}>Forecast again</Button>
				<Button variant="outline" size="small" disabled={pyBusy} onclick={crash}>Crash Python</Button>
				{#if runtime}
					<span class="text-neutral-readable text-xs tabular-nums" data-python-runtime>
						Python {runtime.python} · numpy {runtime.numpy} · process {#if previousPid && previousPid !== runtime.pid}<s>{previousPid}</s> → {/if}{runtime.pid}
					</span>
				{/if}
			</div>
			{#if pyStatus}<p class="text-neutral-readable text-xs" data-python-status>{pyStatus}</p>{/if}
		</section>

		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-module="rust">
			{@render header('File checksum', 'Rust', 'native/rust — a thread of its own per call, inside the app: the window and the server stay free')}
			<p class="text-neutral-readable text-sm">SHA-256 of any file, read in 1 MB chunks, with a progress event every 16 MB.</p>
			<div><Button variant="outline" size="small" onclick={checksum}>Choose a file…</Button></div>
			{#if file}
				<div class="flex flex-col gap-1.5">
					<p class="text-neutral truncate text-sm font-medium">{file.name}</p>
					{#if progress && !file.hex}
						<div class="bg-surface-recessed h-1.5 overflow-hidden rounded-full">
							<div class="bg-primary h-full transition-[width]" style:width="{progress.total ? (progress.bytes / progress.total) * 100 : 0}%"></div>
						</div>
					{/if}
					{#if file.hex}
						<code class="text-neutral-readable break-all text-xs" data-checksum>{file.hex}</code>
						<p class="text-neutral-readable text-xs tabular-nums">
							{size(file.bytes!)} in {Math.round(file.millis!)} ms · {(file.bytes! / (1 << 20) / Math.max(file.millis! / 1000, 0.001)).toFixed(0)} MB/s
						</p>
					{/if}
				</div>
			{/if}
			{#if rustStatus}<p role="alert" class="text-sm">{rustStatus}</p>{/if}
		</section>

		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-module="swift">
			{@render header('Text analysis', 'Swift', 'native/Language.swift — on the main actor, with Apple’s on-device NaturalLanguage: nothing leaves the Mac')}
			<textarea
				bind:value={text}
				rows="3"
				class="border-neutral-muted bg-surface-raised text-neutral focus:ring-focus/50 w-full resize-none rounded-md border p-2 text-sm outline-none focus:ring-2"
				aria-label="Text to analyze"
			></textarea>
			<div class="flex items-center gap-2">
				<Button variant="outline" size="small" onclick={analyze}>Analyze</Button>
				{#if swiftStatus}<span class="text-neutral-readable text-xs">{swiftStatus}</span>{/if}
			</div>
			{#if analysis}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-analysis>
					<dt class="text-neutral-readable">Language</dt>
					<dd class="text-neutral">{languageName(analysis.language)} <span class="text-neutral-readable">({Math.round(analysis.confidence * 100)}%)</span></dd>
					<dt class="text-neutral-readable">Tone</dt>
					<dd class="text-neutral">{tone(analysis.sentiment)} <span class="text-neutral-readable tabular-nums">({analysis.sentiment.toFixed(2)})</span></dd>
					<dt class="text-neutral-readable">Nouns</dt>
					<dd class="flex flex-wrap gap-1">
						{#each analysis.keywords as k (k)}<span class="bg-surface-recessed text-neutral rounded px-1.5 text-xs leading-5">{k}</span>{:else}<span class="text-neutral-readable">—</span>{/each}
					</dd>
				</dl>
			{/if}
		</section>

		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4 md:col-span-2" data-module="ai">
			{@render header('On-device model', 'host.ai', 'Apple’s language model, on the Mac: free, offline, private — macOS 26 with Apple Intelligence on')}
			{#if !aiState}
				<p class="text-neutral-readable text-sm">Checking…</p>
			{:else if !aiState.available}
				<p class="text-neutral text-sm" data-ai-unavailable={aiState.reason}>Unavailable — {reasons[aiState.reason ?? ''] ?? aiState.reason}</p>
				<p class="text-neutral-readable text-xs">The same code runs a cloud model instead: <code>appleIntelligence()</code> from <code>@kitop/shell/ai-sdk</code> is a Vercel AI SDK model.</p>
			{:else}
				<textarea
					bind:value={aiPrompt}
					rows="3"
					class="border-neutral-muted bg-surface-raised text-neutral focus:ring-focus/50 w-full resize-none rounded-md border p-2 text-sm outline-none focus:ring-2"
					aria-label="Prompt"
				></textarea>
				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="small" disabled={aiBusy} onclick={ask}>Ask (streamed)</Button>
					<Button variant="outline" size="small" disabled={aiBusy} onclick={extract}>Extract a task (JSON Schema)</Button>
					{#if aiStatus}<span class="text-neutral-readable text-xs">{aiStatus}</span>{/if}
				</div>
				{#if aiOut}<p class="text-neutral text-sm" data-ai-text>{aiOut}</p>{/if}
				{#if aiTask}<pre class="bg-surface-recessed text-neutral rounded-md p-2 text-xs" data-ai-task>{JSON.stringify(aiTask, null, 2)}</pre>{/if}
			{/if}
		</section>

		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4 md:col-span-2" data-module="terminal">
			{@render header('Terminal', 'Bun.Terminal', 'Your login shell in a pseudo-terminal on the app’s server (src/websocket.ts), drawn by xterm.js — what agent and dev tools apps build on')}
			<Terminal />
		</section>

		<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4 md:col-span-2" data-module="tools">
			{@render header('Your tools', 'host.which', 'Server code: the commands on your shell’s PATH — what agents, git or uv need to be found from an app opened in the Finder')}
			<p class="text-neutral-readable text-xs">The app’s own PATH has {data.appPath} entries; your login shell’s has {data.shellPath}.</p>
			<p class="text-neutral-readable text-xs" data-network>
				Server network: {data.network.systemCertificates ? 'the system’s certificates too' : 'Bun’s certificates only'} ({data.network.certificates} trusted), {data.network.proxy ? `proxy ${data.network.proxy}` : 'no proxy'}.
			</p>
			{#if cmd?.name}
				<div class="flex flex-wrap items-center gap-2 text-sm" data-command>
					<code class="text-neutral">{cmd.name}</code>
					{#if !cmd.available}
						<span class="text-neutral-readable text-xs">installs from the built app</span>
					{:else if cmd.path}
						<span class="text-neutral-readable truncate text-xs">{cmd.path}{cmd.onPath ? '' : ' (not on your PATH)'}</span>
						<Button variant="outline" size="small" onclick={() => commandCall('DELETE')}>Uninstall</Button>
					{:else}
						<Button variant="outline" size="small" onclick={() => commandCall('POST')}>Install the {cmd.name} command</Button>
					{/if}
					{#if cmd.error}<span role="alert" class="text-xs">{cmd.error}</span>{/if}
				</div>
			{/if}
			<ul class="grid gap-1 text-sm sm:grid-cols-2">
				{#each data.tools as t (t.name)}
					<li class="flex min-w-0 items-baseline gap-2">
						<code class="text-neutral w-16 shrink-0">{t.name}</code>
						<span class="text-neutral-readable truncate text-xs" title={t.path ?? ''}>{t.path ?? 'not found'}</span>
					</li>
				{/each}
			</ul>
		</section>
	</div>
</div>
