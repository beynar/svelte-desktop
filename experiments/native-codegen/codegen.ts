/**
 * codegen.ts — reads commands.json, emits bindings.ts (typed $native surface).
 * `bun packages/native/codegen.ts` — run from repo root.
 *
 * Kinds:
 *  scalar           — plain args, scalar return; negative → NativeError
 *  bytes-in         — utf8 arg → (ptr,len); negative → NativeError
 *  handle-bytes     — (u64 handle, utf8) → i64; negative → NativeError
 *  json-in-json-out — utf8 in → heap out + freeSymbol; decode BEFORE free
 *  async            — (args..., done_cb) → task id; Promise resolves on cb.
 *                     cb fires on the JS thread (JSCallback threadsafe).
 */
import { readFileSync, writeFileSync } from 'fs';

interface Cmd {
	name: string; symbol: string;
	kind: 'scalar' | 'bytes-in' | 'handle-bytes' | 'json-in-json-out' | 'u64-out' | 'async';
	args: { name: string; type: string }[];
	returns: string; errors: Record<string, string>; freeSymbol?: string;
}
const reg = JSON.parse(readFileSync('packages/native/commands.json', 'utf8'));

const ffiType = (t: string) => ({ i64: 'FFIType.i64', u64: 'FFIType.u64', i32: 'FFIType.i32' })[t] ?? 'FFIType.ptr';
const ffiRet = (r: string, kind: string) =>
	kind === 'u64-out' ? 'FFIType.i32' : // status; value via out-param
	r === 'json' ? 'FFIType.ptr' : r === 'promise<i64>' ? 'FFIType.u64' : ffiType(r);

let ffiDecl = '';
let body = '';
for (const c of reg.commands as Cmd[]) {
	const ffiArgs = c.args.flatMap((a) =>
		a.type === 'utf8' ? ['FFIType.ptr', 'FFIType.usize'] : [ffiType(a.type)]);
	if (c.kind === 'json-in-json-out') ffiArgs.push('FFIType.ptr'); // out_len
	if (c.kind === 'u64-out') ffiArgs.push('FFIType.ptr'); // out_val — status returns i32
	if (c.kind === 'async') ffiArgs.push('FFIType.function'); // done cb
	ffiDecl += `\t${c.symbol}: { args: [${ffiArgs.join(', ')}], returns: ${ffiRet(c.returns, c.kind)} },\n`;
	if (c.freeSymbol) ffiDecl += `\t${c.freeSymbol}: { args: [FFIType.ptr, FFIType.usize], returns: FFIType.void },\n`;

	const tsArgs = c.args.map((a) => `${a.name}: ${a.type === 'utf8' ? 'string | Uint8Array' : 'number | bigint'}`).join(', ');
	const callArgs = c.args.map((a) => a.type === 'utf8' ? `buf_${a.name}, buf_${a.name}.byteLength` : a.name).join(', ');
	const bufs = c.args.filter((a) => a.type === 'utf8')
		.map((a) => `\tconst buf_${a.name} = typeof ${a.name} === 'string' ? enc.encode(${a.name}) : ${a.name};\n`).join('');
	// status returns are i32 (number) or i64 (bigint) — compare against the right zero
	const neg = (c.returns === 'i32' || c.kind === 'u64-out') ? 'r < 0' : 'r < 0n';
	const errThrow = `if (${neg}) throw new NativeError(${JSON.stringify(c.errors)}[String(r)] ?? 'unknown');`;

	if (c.kind === 'scalar') {
		const ret = c.returns === 'i32' ? 'number' : 'bigint';
		body += `export function ${c.name}(${tsArgs}): ${ret} {\n\tconst r = lib.symbols.${c.symbol}(${callArgs});\n\t${c.errors && Object.keys(c.errors).length ? errThrow : ''}\n\treturn r;\n}\n\n`;
	} else if (c.kind === 'bytes-in' || c.kind === 'handle-bytes') {
		const statusOnly = c.returns === 'i32';
		body += `export function ${c.name}(${tsArgs}): ${statusOnly ? 'void' : 'bigint'} {\n${bufs}\tconst r = lib.symbols.${c.symbol}(${callArgs});\n\t${errThrow}\n${statusOnly ? '' : '\treturn r;\n'}}\n\n`;
	} else if (c.kind === 'u64-out') {
		// status i32 + out-param u64 — full-range values can't ride the error channel
		body += `export function ${c.name}(${tsArgs}): bigint {\n${bufs}\tconst out = new BigUint64Array(1);\n\tconst r = lib.symbols.${c.symbol}(${callArgs ? callArgs + ', ' : ''}ptr(out));\n\t${errThrow}\n\treturn out[0];\n}\n\n`;
	} else if (c.kind === 'json-in-json-out') {
		body += `export function ${c.name}(${tsArgs}): unknown {\n${bufs}\tconst outLen = new BigUint64Array(1);\n\tconst p = lib.symbols.${c.symbol}(${callArgs ? callArgs + ', ' : ''}ptr(outLen));\n\tif (!p) throw new NativeError(${JSON.stringify(c.errors.null ?? 'transform_failed_or_panic')});\n\tconst out = dec.decode(new Uint8Array(toArrayBuffer(p, 0, Number(outLen[0]))).slice());\n\tlib.symbols.${c.freeSymbol!}(p, Number(outLen[0]));\n\treturn JSON.parse(out);\n}\n\n`;
	} else if (c.kind === 'async') {
		// task registry: id → {resolve}; cb kept alive until fired.
		body += `export function ${c.name}(${tsArgs}): Promise<bigint> & { taskId: Promise<bigint> } {\n\tlet resolve!: (v: bigint) => void;\n\tconst done = new Promise<bigint>((r) => { resolve = r; });\n\tconst cb = new JSCallback((taskId: bigint, status: number) => {\n\t\ttasks.delete(taskId);\n\t\tcb.close();\n\t\tresolve(BigInt(taskId) * 2n + BigInt(status)); // status packed: even=ok, odd=cancelled\n\t}, { args: ['u64', 'i32'], returns: 'void', threadsafe: true });\n\tconst id = lib.symbols.${c.symbol}(${callArgs ? callArgs + ', ' : ''}cb.ptr);\n\ttasks.set(id, cb);\n\tconst p = done.then((packed) => {\n\t\tconst cancelled = packed % 2n === 1n;\n\t\tconst task = packed / 2n;\n\t\tif (cancelled) throw new NativeError('cancelled');\n\t\treturn task;\n\t}) as Promise<bigint> & { taskId: Promise<bigint> };\n\tp.taskId = Promise.resolve(id);\n\treturn p;\n}\n\n`;
	}
}

const out = `// GENERATED by packages/native/codegen.ts from commands.json — do not edit.
import { dlopen, FFIType, ptr, toArrayBuffer, JSCallback } from 'bun:ffi';
import { join } from 'path';

export class NativeError extends Error { constructor(public code: string) { super(code); } }

const lib = dlopen(
	join(import.meta.dir, '../../crates/native-core/lib${reg.library}.dylib'),
	{
${ffiDecl.slice(0, -1)}
	},
);
const enc = new TextEncoder();
const dec = new TextDecoder();
const tasks = new Map<bigint, JSCallback>();

${body}`;

writeFileSync('packages/native/bindings.ts', out);
console.log('emitted packages/native/bindings.ts');
