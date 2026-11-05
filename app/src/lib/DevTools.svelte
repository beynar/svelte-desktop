<script lang="ts">
	import { devtools } from './devtools-state.svelte.js';
	const tabs = [
		{ id: 'perf' as const, label: 'Perf' },
		{ id: 'console' as const, label: 'Console' },
		{ id: 'network' as const, label: 'Network' },
	];

	const LEVEL_COLOR: Record<string, string> = {
		log: '#d8d8de',
		info: '#64d2ff',
		debug: '#8e8e96',
		warn: '#ffd60a',
		error: '#ff453a',
	};

	function fmtMs(v: number): string {
		return v < 1 ? `${(v * 1000).toFixed(0)}μs` : `${v.toFixed(1)}ms`;
	}

	function fmtTime(ts: number): string {
		const d = new Date(ts);
		return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
	}


</script>

<div class="devtools" class:open={devtools.open}>
	<!-- collapsed bar — always visible -->
	<button class="bar" onclick={() => (devtools.open = !devtools.open)}>
		<span class="fps" class:slow={(devtools.perf?.p90Ms ?? 0) > 16.7}>
			{devtools.perf ? fmtMs(devtools.perf.p90Ms) : '—'} frame
		</span>
		<span class="frame-ms">
			{devtools.perf?.fps ?? 0} paint/s
		</span>
		{#if devtools.logs.length}
			<span class="badge">{devtools.logs.length}</span>
		{/if}
		<span class="chevron">{devtools.open ? '▾' : '▴'}</span>
	</button>

	{#if devtools.open}
		<div class="panel">
			<div class="tab-row">
				{#each tabs as t}
					<button
						class="tab"
						class:sel={devtools.tab === t.id}
						onclick={() => (devtools.tab = t.id)}
					>
						{t.label}
						{#if t.id === 'console' && devtools.logs.length}
							<span class="tab-badge">{devtools.logs.length}</span>
						{/if}
						{#if t.id === 'network' && devtools.requests.length}
							<span class="tab-badge">{devtools.requests.length}</span>
						{/if}
					</button>
				{/each}
				<div class="tab-spacer"></div>
				{#if devtools.tab === 'console'}
					<button class="clear" onclick={() => devtools.clearLogs()}>Clear</button>
				{/if}
				{#if devtools.tab === 'network'}
					<button class="clear" onclick={() => devtools.clearRequests()}>Clear</button>
				{/if}
			</div>

			<div class="body">
				{#if devtools.tab === 'perf'}
					{@const p = devtools.perf}
					{#if p}
						<div class="perf-grid">
							<div class="perf-stat">
								<div class="perf-val">{fmtMs(p.p90Ms)}</div>
								<div class="perf-label">frame p90</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{fmtMs(p.p99Ms)}</div>
								<div class="perf-label">frame p99</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{fmtMs(p.maxMs)}</div>
								<div class="perf-label">frame max</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{fmtMs(p.currentMs)}</div>
								<div class="perf-label">frame now</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{p.fps}</div>
								<div class="perf-label">paint fps</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{p.capFps}</div>
								<div class="perf-label">cap fps</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{p.p90Ms <= 8.3 ? '120fps' : p.p90Ms <= 16.7 ? '60fps' : '<60fps'}</div>
								<div class="perf-label">budget</div>
							</div>
							<div class="perf-stat">
								<div class="perf-val">{p.frames}</div>
								<div class="perf-label">painted</div>
							</div>
						</div>
					{:else}
						<div class="empty">waiting for frame stats…</div>
					{/if}
				{:else if devtools.tab === 'console'}
					<div class="log-list">
						{#each devtools.logs as entry}
							<div class="log-line" style="color:{LEVEL_COLOR[entry.level] ?? '#d8d8de'}">
								<span class="log-time">{fmtTime(entry.time)}</span>
								<span class="log-level">[{entry.level}]</span>
								<span class="log-text">{entry.text}</span>
							</div>
						{/each}
						{#if !devtools.logs.length}
							<div class="empty">no console output</div>
						{/if}
					</div>
				{:else if devtools.tab === 'network'}
					<div class="net-list">
						{#each devtools.requests as req}
							<div class="net-line">
								<span class="net-method">{req.method}</span>
								<span class="net-url">{req.url}</span>
								<span class="net-status" class:err={!req.ok}>{req.status ?? 'ERR'}</span>
								<span class="net-dur">{fmtMs(req.duration)}</span>
							</div>
						{/each}
						{#if !devtools.requests.length}
							<div class="empty">no network requests</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.devtools {
		display: flex;
		flex-direction: column;
		border-top-width: 1px;
		border-color: #34343c;
		background-color: #1a1a1f;
		flex-shrink: 0;
	}
	.bar {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 10px;
		padding: 5px 12px;
		background-color: #1a1a1f;
		border-width: 0;
		cursor: pointer;
		user-select: none;
	}
	.bar:hover {
		background-color: #222228;
	}
	.fps {
		font-size: 11px;
		font-weight: 600;
		color: #30d158;
		min-width: 42px;
	}
	.fps.slow {
		color: #ff453a;
	}
	.frame-ms {
		font-size: 10px;
		color: #8e8e96;
	}
	.badge {
		font-size: 9px;
		font-weight: 600;
		background-color: #0a84ff;
		color: #fff;
		border-radius: 8px;
		padding: 1px 5px;
	}
	.chevron {
		font-size: 10px;
		color: #6e6e76;
		margin-left: auto;
	}
	.panel {
		display: flex;
		flex-direction: column;
		height: 200px;
		border-top-width: 1px;
		border-color: #34343c;
	}
	.tab-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 2px;
		padding: 4px 8px;
		background-color: #222228;
	}
	.tab {
		font-size: 11px;
		padding: 3px 10px;
		border-radius: 5px;
		border-width: 0;
		background-color: transparent;
		color: #8e8e96;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.tab:hover {
		background-color: #2e2e36;
	}
	.tab.sel {
		background-color: #0a84ff;
		color: #fff;
	}
	.tab-badge {
		font-size: 9px;
		font-weight: 600;
		background-color: rgba(255,255,255,0.2);
		border-radius: 6px;
		padding: 0 4px;
	}
	.tab-spacer {
		flex: 1;
	}
	.clear {
		font-size: 10px;
		padding: 2px 8px;
		border-radius: 4px;
		border-width: 1px;
		border-color: #3a3a42;
		background-color: transparent;
		color: #8e8e96;
		cursor: pointer;
	}
	.clear:hover {
		background-color: #2e2e36;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 6px 10px;
	}
	.empty {
		font-size: 11px;
		color: #55555e;
		padding: 20px;
		text-align: center;
	}
	/* perf */
	.perf-grid {
		display: flex;
		flex-direction: row;
		gap: 16px;
		padding: 4px 0;
	}
	.perf-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		min-width: 52px;
	}
	.perf-val {
		font-size: 16px;
		font-weight: 700;
		color: #f2f2f7;
	}
	.perf-label {
		font-size: 9px;
		color: #6e6e76;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	/* console */
	.log-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.log-line {
		display: flex;
		flex-direction: row;
		gap: 6px;
		font-size: 11px;
		line-height: 16px;
		font-family: Menlo, monospace;
	}
	.log-time {
		color: #55555e;
		font-size: 9px;
		min-width: 52px;
	}
	.log-level {
		font-size: 9px;
		min-width: 42px;
		font-weight: 600;
	}
	.log-text {
		flex: 1;
		white-space: pre-wrap;
		word-break: break-all;
	}
	/* network */
	.net-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.net-line {
		display: flex;
		flex-direction: row;
		gap: 8px;
		font-size: 11px;
		line-height: 16px;
		font-family: Menlo, monospace;
		align-items: baseline;
	}
	.net-method {
		font-weight: 700;
		color: #64d2ff;
		min-width: 36px;
		font-size: 10px;
	}
	.net-url {
		flex: 1;
		color: #d8d8de;
		overflow: hidden;
		white-space: nowrap;
	}
	.net-status {
		font-weight: 600;
		color: #30d158;
		min-width: 28px;
		text-align: right;
	}
	.net-status.err {
		color: #ff453a;
	}
	.net-dur {
		color: #6e6e76;
		min-width: 48px;
		text-align: right;
		font-size: 10px;
	}
</style>
