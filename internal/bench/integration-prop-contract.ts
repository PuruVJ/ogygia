#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORM ↔ RUNTIME INTEGRATION — the island-prop contract.
//
// An island's captured props cross the SSR→client boundary as a `<script data-ogygia-props>` tag:
// Region.svelte ENCODES them (`stringify(props, {transportable, snippet reducers})` then escapes
// `<`→`<` so the payload can't break out of the script), and core.ts DECODES them
// (`parse(textContent, {revivers})`). This fuzzes that exact pipeline for:
//   1. FIDELITY — every devalue type + adversarial string round-trips byte-identical.
//   2. INJECTION SAFETY — a prop value of `</script>…` must never survive the escape unescaped.
// Both are security- and correctness-critical; this guards the contract against drift.
//
//   node internal/bench/integration-prop-contract.ts
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSPORT_WIRE_KEY, reduce_transportable, revive_transportable } from '../../packages/ogygia/dist/live-transport.js';
import { REGION_SNIPPET_WIRE_KEY, reduce_region_snippet, revive_region_snippet } from '../../packages/ogygia/dist/region-snippet.js';

// devalue lives in the pnpm store (symlinked under packages/ogygia/node_modules), not repo-root
// node_modules, so a bare `import 'devalue'` from here doesn't resolve — find it and import by path.
const repo = fileURLToPath(new URL('../..', import.meta.url));
function devaluePath(): string {
	const store = join(repo, 'node_modules/.pnpm');
	const hit = existsSync(store) ? readdirSync(store).find((d) => d.startsWith('devalue@')) : null;
	if (hit) return join(store, hit, 'node_modules/devalue/index.js');
	return join(repo, 'packages/ogygia/node_modules/devalue/index.js');
}
const { stringify, parse } = (await import(devaluePath())) as typeof import('devalue');

const reducers = { [TRANSPORT_WIRE_KEY]: reduce_transportable, [REGION_SNIPPET_WIRE_KEY]: reduce_region_snippet };
const revivers = { [TRANSPORT_WIRE_KEY]: (d: never) => revive_transportable(d, true), [REGION_SNIPPET_WIRE_KEY]: revive_region_snippet };
// EXACTLY Region.svelte's emit: stringify(reducers), then `.split('<').join('\\u003C')`.
const escape = (s: string) => s.split('<').join('\\u003C');
const encode = (props: Record<string, unknown>) => escape(stringify(props, reducers));
const decode = (payload: string) => parse(payload, revivers);

function deep(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
	if (a instanceof Map && b instanceof Map) { if (a.size !== b.size) return false; for (const [k, v] of a) if (!deep(v, b.get(k))) return false; return true; }
	if (a instanceof Set && b instanceof Set) { if (a.size !== b.size) return false; const bb = [...b]; return [...a].every((v, i) => deep(v, bb[i])); }
	if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
	if (a && b && typeof a === 'object') { const ka = Object.keys(a), kb = Object.keys(b as object); if (ka.length !== kb.length) return false; return ka.every((k) => deep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])); }
	if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b);
	return false;
}

const cases: Record<string, Record<string, unknown>> = {
	plain: { start: 5, label: 'hi', on: true, no: null },
	'Date/Map/Set/BigInt': { d: new Date('2024-01-02T03:04:05.678Z'), m: new Map([['a', 1], ['b', 2]]), s: new Set([1, 2, 3]), big: 9007199254740993n },
	'RegExp/undefined/-0/Inf/NaN': { re: /ab+c/gi, u: undefined, nz: -0, inf: Infinity, ninf: -Infinity, nan: NaN },
	'string with <': { x: 'a < b <= c', tag: '<div class="x">hi</div>' },
	'SCRIPT INJECTION': { x: '</script><script>alert(1)</script>', y: '</SCRIPT ', z: '</script foo' },
	'literal backslash-u003C': { x: 'literal \\u003C not a tag', y: 'a\\u003Cb' },
	'quotes/newlines/unicode': { x: 'he said "hi"\nline2\ttab', u: '日本語 \u{1F3DD}️ café', bs: 'a\\b' },
	'nested deep': { a: { b: { c: { d: [1, { e: new Date(0) }, new Set(['x'])] } } } },
	'empty/edge': { arr: [], obj: {}, es: '', zero: 0, no: false },
	'huge string with <': { x: 'z<'.repeat(50000) },
	'sparse-ish array': { a: [1, undefined, 3, undefined, null] }
};

let pass = 0, fail = 0, injections = 0;
console.log('\x1b[1m\x1b[36m▸ transform↔runtime prop contract — fidelity + injection fuzz\x1b[0m');
for (const [name, props] of Object.entries(cases)) {
	let enc: string;
	try { enc = encode(props); } catch (e) { console.log(`  \x1b[31mENCODE-FAIL ${name}: ${(e as Error).message}\x1b[0m`); fail++; continue; }
	if (/<\/script/i.test(enc)) { console.log(`  \x1b[31mINJECTION ${name}: escaped payload still contains </script\x1b[0m`); injections++; }
	let out: unknown;
	try { out = decode(enc); } catch (e) { console.log(`  \x1b[31mDECODE-FAIL ${name}: ${(e as Error).message}\x1b[0m`); fail++; continue; }
	if (deep(props, out)) pass++;
	else { fail++; console.log(`  \x1b[31mFIDELITY ${name}: round-trip changed the value\x1b[0m`); }
}
console.log(`\n  ${pass} faithful, ${fail} fidelity/encode/decode failures, ${injections} injection escapes  ${fail || injections ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mPASS ✓\x1b[0m'}`);
if (fail || injections) process.exitCode = 1;
