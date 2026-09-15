// Compiles the shadcn registry theme (tailwind v4) into flat css our gdom
// classRules engine can consume: at-rule blocks dropped, @layer unwrapped,
// var(--x) substituted with the :root literal table.
import { writeFileSync } from 'fs';

const out = 'src/gen/theme.raw.css';
const proc = Bun.spawnSync(
	['bunx', '@tailwindcss/cli', '-i', 'src/shadcn/theme-input.css', '-o', out, '--cwd', process.cwd()],
	{ stdout: 'pipe', stderr: 'pipe' },
);
if (proc.exitCode !== 0) {
	console.error(new TextDecoder().decode(proc.stderr).slice(0, 3000));
	process.exit(1);
}
let css = await Bun.file(out).text();
css = css.replace(/\/\*[\s\S]*?\*\//g, '');

// @property blocks carry the initial-value of tailwind's internal --tw-* vars;
// harvest them before the at-rule pass drops the blocks wholesale
const propDefaults = new Map<string, string>();
for (const m of css.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
	const iv = /initial-value\s*:\s*([^;}]+)/.exec(m[2]);
	if (iv) propDefaults.set(m[1], iv[1].trim());
}

// drop whole balanced at-rule blocks; unwrap @layer/@media/@supports keeping
// their contents (a desktop window satisfies every breakpoint + hover query)
const DROP = /^@(media|supports|keyframes|font-face|property|charset|custom-variant|theme|utility|import|source|tailwind|container|scope|starting-style)\b/;
function flattenAtRules(css: string) {
	let result = '';
	let i = 0;
	const n = css.length;
	while (i < n) {
		const at = css.indexOf('@', i);
		const brace = css.indexOf('{', i);
		if (at === -1) { result += css.slice(i); break; }
		if (brace !== -1 && brace < at) { result += css.slice(i, at); i = at; }
		const headerEnd = css.indexOf('{', at);
		const stmtEnd = css.indexOf(';', at);
		// statement at-rule (no block): @import ...;
		if (stmtEnd !== -1 && (headerEnd === -1 || stmtEnd < headerEnd)) {
			const stmt = css.slice(at, stmtEnd);
			if (!DROP.test(stmt)) result += css.slice(i, at) + stmt + ';';
			else result += css.slice(i, at);
			i = stmtEnd + 1;
			continue;
		}
		if (headerEnd === -1) { result += css.slice(i, at); break; }
		const header = css.slice(at, headerEnd);
		// find matching close brace
		let depth = 0, j = headerEnd;
		for (; j < n; j++) {
			if (css[j] === '{') depth++;
			else if (css[j] === '}') { depth--; if (depth === 0) break; }
		}
		const inner = css.slice(headerEnd + 1, j);
		result += css.slice(i, at);
		// recurse: unwrapped blocks contain rules with their own nested at-rules
		// (`&:hover{ @media (hover:hover){} }`) that still need flattening
		if (/^@(layer|media|supports)\b/.test(header)) result += flattenAtRules(inner);
		i = j + 1;
	}
	return result;
}
let result = flattenAtRules(css);

// nested rules (&:hover{ }, &[data-active]{ }...) carry the registry's whole
// interactive layer — hoist `&`-selectors to top-level (`&:x` → `parent:x`),
// drop the rest (descendants can't be evaluated by the flat matcher)
{
	let out2 = '';
	let i = 0;
	while (i < result.length) {
		const open = result.indexOf('{', i);
		if (open === -1) { out2 += result.slice(i); break; }
		const parentSel = result.slice(i, open).trim();
		let depth = 0, j = open, body = '', hoisted = '';
		for (; j < result.length; j++) {
			const ch = result[j];
			if (ch === '{') {
				if (depth > 0) {
					// nested rule: header = chars since last ';' in body
					let d2 = 0, k = j;
					for (; k < result.length; k++) {
						if (result[k] === '{') d2++;
						else if (result[k] === '}') { d2--; if (d2 === 0) break; }
					}
					const lastSemi = body.lastIndexOf(';');
					const header = body.slice(lastSemi + 1).trim();
					const inner = result.slice(j + 1, k);
					if (header.includes('&')) {
						for (const ps of parentSel.split(',')) {
							const p = ps.trim();
							if (p) hoisted += `${header.replaceAll('&', p)}{${inner}}`;
						}
					}
					body = lastSemi === -1 ? '' : body.slice(0, lastSemi + 1);
					j = k;
					continue;
				}
				depth++;
				continue; // don't emit the opening brace into body
			}
			if (ch === '}') {
				depth--;
				if (depth === 0) break;
			}
			if (depth > 0) body += ch;
		}
		out2 += result.slice(i, open) + '{' + body + '}' + hoisted;
		i = j + 1;
	}
	result = out2;
}
// hoisted rules can carry nested @media (hover:hover) / @supports wrappers —
// flatten them now that the at-rules are reachable
result = flattenAtRules(result);

// the registry scopes every component class under `.style-vega X` — the desktop
// root is always inside that single style scope, so reduce to plain `X`
result = result.replace(/\.style-vega\s+/g, '');

// collect --vars from :root/.dark-bearing selectors (`:root, :host {}` is how
// tailwind v4 emits them) then resolve var(--x[, fallback])
const vars = new Map<string, string>();
const isVarScope = (sel: string) =>
	sel.split(',').some((s) => /^\s*(:root|:host|\.dark|html)\s*$/.test(s));
for (const m of result.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
	if (!isVarScope(m[1])) continue;
	for (const d of m[2].split(';')) {
		const c = d.indexOf(':');
		if (c === -1) continue;
		const k = d.slice(0, c).trim();
		if (k.startsWith('--')) vars.set(k, d.slice(c + 1).trim());
	}
}
for (const [k, v] of propDefaults) if (!vars.has(k)) vars.set(k, v);
const resolveVar = (s: string) =>
	s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (m, k, fb) => {
		const v = vars.get(k);
		// self-referential (--font-sans: var(--font-sans)) → take fallback/drop
		if (v && v !== m) return v;
		return fb ? resolveVar(fb.trim()) : m;
	});
for (let pass = 0; pass < 4 && /var\(/.test(result); pass++) result = resolveVar(result);
// drop the var-declaring rules themselves
result = result.replace(/([^{}]+)\{([^}]*)\}/g, (m, sel) => (isVarScope(sel) ? '' : m));

const emit = `export default ${JSON.stringify(result)};\n`;
writeFileSync('src/gen/theme-css.js', emit);
console.log(`theme → src/gen/theme-css.js (${result.length} chars, ${vars.size} vars)`);
