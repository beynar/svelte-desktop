#!/usr/bin/env bun
/**
 * svelte-native build — emit the native entry + compile it to a spawnable
 * bundle. The supported production path (the adapter exists for config-shape
 * compatibility but a real `svelte-kit build` can't run without kit
 * internals — see adapter.js header).
 *
 *   bun packages/svelte-native/build.js [appRoot] [--outDir .svelte-native]
 *       [--backend @gpuix/native] [--renderer GpuixRenderer] [--headless]
 *       [--title T] [--width W] [--height H]
 *       [--path /start] [--routes src/routes] [--params src/params]
 *
 * Output: <appRoot>/.svelte-native/app.js — run with `bun` (or hand to
 * `bun build --compile`).
 */
import { buildNativeApp } from './emit.js';

const args = process.argv.slice(2);
const opts = {};
let root = null;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === '--outDir') opts.outDir = args[++i];
	else if (a === '--backend') opts.backend = args[++i];
	else if (a === '--renderer') opts.rendererClass = args[++i];
	else if (a === '--headless') opts.headless = true;
	else if (a === '--title') opts.title = args[++i];
	else if (a === '--width') opts.width = Number(args[++i]);
	else if (a === '--height') opts.height = Number(args[++i]);
	else if (a === '--path') opts.startPath = args[++i];
	else if (a === '--routes') opts.pluginOptions = { ...opts.pluginOptions, routesDir: args[++i] };
	else if (a === '--params') opts.pluginOptions = { ...opts.pluginOptions, paramsDir: args[++i] };
	else if (!a.startsWith('--') && !root) root = a;
	else {
		console.error(`unknown arg: ${a}`);
		process.exit(1);
	}
}

try {
	const { bundlePath } = await buildNativeApp({ root: root ?? process.cwd(), ...opts });
	console.log(`[svelte-native] built → ${bundlePath}`);
	console.log(`[svelte-native] run:   bun ${bundlePath}`);
} catch (e) {
	console.error('[svelte-native] build failed:', e);
	process.exit(1);
}
