/**
 * Mission bench — transport costs.
 *  A) NAPI call overhead: TestGpuixRenderer methods via @gpuix/native (.node)
 *  B) FFI call overhead:  quickgui_protocol_version via bun:ffi dlopen
 *  C) applyBatch throughput: JSON op batches of growing size through NAPI
 *  D) event drain: drainEvents() on idle renderer
 * Writes JSONL to ../results/run-20260915-a/bridge.jsonl
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { dlopen, FFIType } from 'bun:ffi';
import { appendFileSync, mkdirSync } from 'fs';

const OUT = '../results/run-20260915-a/bridge.jsonl';
mkdirSync('../results/run-20260915-a', { recursive: true });
const rec = (o: object) => appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + '\n');

function stats(times: number[]) {
	const s = [...times].sort((a, b) => a - b);
	const med = s[Math.floor(s.length / 2)];
	const p95 = s[Math.floor(s.length * 0.95)];
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return { mean, med, p95, min: s[0], max: s[s.length - 1], n: s.length };
}

// ── A/B: raw call overhead ──────────────────────────────────────────────
const qg = dlopen(
	`${import.meta.dir}/../node_modules/@quickgui/native/lib/darwin-arm64/libquickgui_host.dylib`,
	{ quickgui_protocol_version: { args: [], returns: 'u32' } },
);
const renderer = new TestGpuixRenderer(800, 600);

const N = 100_000;
{
	const t0 = performance.now();
	for (let i = 0; i < N; i++) qg.symbols.quickgui_protocol_version();
	const ffiMs = (performance.now() - t0) / N;
	// NAPI no-op-ish call: hasTestGpuixRenderer is exported fn
	const { hasTestGpuixRenderer } = await import('@gpuix/native');
	const t1 = performance.now();
	for (let i = 0; i < N; i++) hasTestGpuixRenderer();
	const napiMs = (performance.now() - t1) / N;
	rec({ bench: 'call-overhead-us', ffi: ffiMs * 1000, napi: napiMs * 1000, n: N });
	console.log(`call overhead:  ffi=${(ffiMs * 1000).toFixed(3)}µs  napi=${(napiMs * 1000).toFixed(3)}µs`);
}

// ── C: applyBatch throughput vs batch size ──────────────────────────────
for (const count of [1, 10, 100, 1_000, 10_000]) {
	const ops = Array.from({ length: count }, (_, i) => [
		'setStyle', (i % 500) + 1, { opacity: 0.5 },
	]);
	// ensure elements exist for realism on small batches
	const batch = JSON.stringify(ops);
	const times: number[] = [];
	for (let i = 0; i < 30; i++) {
		const t0 = performance.now();
		renderer.applyBatch(batch);
		times.push(performance.now() - t0);
	}
	const s = stats(times);
	rec({ bench: 'applyBatch', opsPerBatch: count, bytes: batch.length, ...s });
	console.log(`applyBatch ${String(count).padStart(5)} ops (${(batch.length / 1024).toFixed(0)}KiB): mean=${s.mean.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms`);
}

// ── C2: payload scaling — setText with big strings ──────────────────────
for (const bytes of [16, 1024, 1_048_576, 10_485_760]) {
	const payload = 'x'.repeat(bytes);
	const batch = JSON.stringify([['setText', 1, payload]]);
	const times: number[] = [];
	for (let i = 0; i < 10; i++) {
		const t0 = performance.now();
		renderer.applyBatch(batch);
		times.push(performance.now() - t0);
	}
	const s = stats(times);
	rec({ bench: 'applyBatch-payload', bytes, ...s });
	console.log(`applyBatch payload ${(bytes / 1024).toFixed(0)}KiB: mean=${s.mean.toFixed(2)}ms`);
}

// ── D: event drain on idle ──────────────────────────────────────────────
{
	const times: number[] = [];
	for (let i = 0; i < 1000; i++) {
		const t0 = performance.now();
		renderer.drainEvents();
		times.push(performance.now() - t0);
	}
	const s = stats(times);
	rec({ bench: 'drainEvents-idle', ...s });
	console.log(`drainEvents idle: mean=${(s.mean * 1000).toFixed(1)}µs p95=${(s.p95 * 1000).toFixed(1)}µs`);
}

console.log('wrote', OUT);
