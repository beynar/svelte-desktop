import { frameStats } from '@svelte-desktop/gpuix/native';

export interface LogEntry {
	level: 'log' | 'warn' | 'error' | 'info' | 'debug';
	text: string;
	time: number;
}

export interface NetEntry {
	method: string;
	url: string;
	status: number | null;
	duration: number;
	ok: boolean;
	time: number;
}

export interface PerfSnapshot {
	fps: number;
	capFps: number;
	currentMs: number;
	p90Ms: number;
	p99Ms: number;
	maxMs: number;
	frames: number;
	samples: number;
}

const LOG_CAP = 500;
const REQ_CAP = 200;
const PENDING_CAP = 1000;

class DevToolsState {
	open = $state(false);
	tab = $state<'perf' | 'console' | 'network'>('perf');
	logs = $state<LogEntry[]>([]);
	requests = $state<NetEntry[]>([]);
	perf = $state<PerfSnapshot | null>(null);
	private frameHistory: [frames: number, at: number][] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			// flush accumulated logs+requests → one $state write per interval
			if (this.pending.length) {
				this.logs = this.logs.concat(this.pending).slice(-LOG_CAP);
				this.pending = [];
			}
			if (this.pendingReqs.length) {
				this.requests = this.requests.concat(this.pendingReqs).slice(-REQ_CAP);
				this.pendingReqs = [];
			}
			const s = frameStats();
			if (!s) return;
			// real fps: frames painted in the last ~1s (frameStats().fps is
			// per-interval × 4 at 250ms polls — meaningless at idle)
			const now = performance.now();
			this.frameHistory.push([s.frames, now]);
			if (this.frameHistory.length > 4) this.frameHistory.shift();
			const oldest = this.frameHistory[0];
			if (!oldest) return;
			const fps = Math.round(((s.frames - oldest[0]) * 1000) / Math.max(1, now - oldest[1]));
			const capFps = s.p90Ms ? Math.round(1000 / s.p90Ms) : 0;
			this.perf = {
				fps,
				capFps,
				currentMs: s.currentMs ?? 0,
				p90Ms: s.p90Ms ?? 0,
				p99Ms: s.p99Ms ?? 0,
				maxMs: s.maxMs ?? 0,
				frames: s.frames ?? 0,
				samples: s.samples ?? 0,
			};
		}, 250);
	}

	stop() {
		if (this.timer) { clearInterval(this.timer); this.timer = null; }
	}

	private pending: LogEntry[] = [];
	private pendingReqs: NetEntry[] = [];

	pushLog(level: LogEntry['level'], args: unknown[]) {
		// plain array, not $state — a console call inside a re-render must not
		// schedule another re-render (infinite loop → stack overflow)
		this.pending.push({ level, text: args.map(stringify).join(' '), time: Date.now() });
		if (this.pending.length > PENDING_CAP) this.pending.splice(0, this.pending.length - PENDING_CAP);
	}

	pushRequest(entry: Omit<NetEntry, 'time'>) {
		this.pendingReqs.push({ ...entry, time: Date.now() });
		if (this.pendingReqs.length > PENDING_CAP) this.pendingReqs.splice(0, this.pendingReqs.length - PENDING_CAP);
	}

	clearLogs() {
		this.logs = [];
		this.pending = [];
	}

	clearRequests() {
		this.requests = [];
		this.pendingReqs = [];
	}
}

function stringify(v: unknown): string {
	if (typeof v === 'string') return v;
	if (v instanceof Error) return `${v.name}: ${v.message}`;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export const devtools = new DevToolsState();

// ── interception ────────────────────────────────────────────────────

const LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;
const G = globalThis as {
	__devtoolsInstalled?: boolean;
	__devtoolsSink?: DevToolsState;
};

export function initDevTools() {
	// always re-point the sink — a module-reload realm gets a fresh
	// DevToolsState; the interceptors (installed once) delegate to it
	G.__devtoolsSink = devtools;

	if (G.__devtoolsInstalled) { devtools.start(); return; }
	G.__devtoolsInstalled = true;

	for (const level of LEVELS) {
		const orig = console[level];
		console[level] = (...args: unknown[]) => {
			orig.apply(console, args);
			G.__devtoolsSink?.pushLog(level, args);
		};
	}

	const origFetch = globalThis.fetch;
	if (origFetch) {
		const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
			const start = performance.now();
			try {
				const res = await origFetch(input, init);
				G.__devtoolsSink?.pushRequest({
					method,
					url,
					status: res.status,
					duration: performance.now() - start,
					ok: res.ok,
				});
				return res;
			} catch (err) {
				G.__devtoolsSink?.pushRequest({
					method,
					url,
					status: null,
					duration: performance.now() - start,
					ok: false,
				});
				throw err;
			}
		};
		globalThis.fetch = Object.assign(wrapped, { preconnect: origFetch.preconnect });
	}

	devtools.start();
}
