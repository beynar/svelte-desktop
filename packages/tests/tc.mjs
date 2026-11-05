import { compileModule } from 'svelte/compiler';
const src = await Bun.file('src/remote.svelte.js').text();
try {
  compileModule(src, { generate:'client', filename:'src/remote.svelte.js', dev:false });
  console.log('OK');
} catch(e) { console.log('ERR at', e.position, e.message.split('\n')[0]); console.log(JSON.stringify(src.slice(Math.max(0,(e.position?.[0]??0)-80), (e.position?.[0]??0)+40))); }
