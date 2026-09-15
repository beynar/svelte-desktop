import { compile } from 'svelte/compiler';
import { readFileSync } from 'fs';
const src = readFileSync('test.svelte', 'utf8');
const out = compile(src, { generate: 'client', filename: 'test.svelte' });
console.log(out.js.code);
