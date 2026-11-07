import { installGlobals, doc } from './gdom';
installGlobals();
// simulate: parse a stylesheet with a compound class selector, then check matching
const st = doc.createElement('style');
st.textContent = '.cards.svelte-x {display:flex;flex-direction:row;gap:12px;} .logo.svelte-x {width:18px;}';
doc.head.appendChild(st);
const el = doc.createElement('div');
el.className = 'cards svelte-x';
doc.body.appendChild(el);
console.log('cards props:', JSON.stringify(Object.fromEntries((el as any)._classProps ?? new Map())));
