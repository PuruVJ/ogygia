#!/usr/bin/env node
// COMPILER MICRO-STRESS: drive transformHost directly with pathological inputs. Fast (no full
// build) → fits a tight loop cadence. Measures scaling with island count, nesting depth, and
// content size; asserts determinism and flags super-linear / exponential blowup.
//
// FIXED 2026-08-16: nested islands USED to be O(2^depth) — `visit_usages` re-descended every
// Component's fragment twice (CHILD_KEYS already had `fragment` + a redundant explicit re-visit), so
// depth-18 ≈ 62ms and depth-25 hung. Now O(depth), linear (~1.0×/level). This harness is the
// regression guard: the nesting per-level factor must stay ≈ 1. Island COUNT is ~O(n^1.7), content
// is linear — both fine. Caps stay in the safe zone so this never hangs even if a regression lands.
import { transformHost } from '../../packages/ogygia/dist/compiler/region/transform.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.join(process.cwd(), 'apps/playground');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = {
	root, libDir: path.join(root, 'src/lib'), pathModule: path, dev: false, ssr: true,
	linkVirtualIsland: true, csrTrue: false, visibleMargin: '0px', idSalt: 'stress', presets: {},
	importKeys: { wake: 'wake', render: 'render', preset: 'preset', region: 'region' },
	clientBindingStub: 'virtual:ogygia/client-binding-stub', readFile: () => null,
	virtualPathFor: (iid: string) => `virtual:ogygia/region/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => p
};
const digest = (r: unknown) => createHash('sha256').update(JSON.stringify((r as { code?: string })?.code ?? r ?? '')).digest('hex').slice(0, 10);
function time(src: string, id: string): { ms: number; det: boolean } {
	transformHost(src, id, ctx); // warm
	const d0 = digest(transformHost(src, id, ctx));
	const ts: number[] = [];
	let det = true;
	for (let k = 0; k < 5; k++) { const s = performance.now(); const r = transformHost(src, id, ctx); ts.push(performance.now() - s); if (digest(r) !== d0) det = false; }
	ts.sort((a, b) => a - b);
	return { ms: ts[2], det };
}
const manyIslands = (n: number) => `<script>\n${Array.from({ length: n }, (_, i) => `\timport C${i} from '$lib/C${i}.svelte' with { wake: '${['load', 'idle', 'visible', 'interaction'][i % 4]}' };`).join('\n')}\n</script>\n${Array.from({ length: n }, (_, i) => `<C${i} start={${i}} />`).join('\n')}`;
const nest = (d: number) => { let inner = '<C start={0} />'; for (let i = 0; i < d; i++) inner = `<Wrap>${inner}</Wrap>`; return `<script>\n\timport C from '$lib/C.svelte' with { wake: 'load' };\n\timport Wrap from '$lib/Wrap.svelte' with { wake: 'visible' };\n</script>\n${inner}`; };
const content = (kb: number) => `<script>\n\timport C from '$lib/C.svelte' with { wake: 'load' };\n</script>\n<C start={0} />\n${('lorem ipsum dolor sit amet '.repeat(30) + '\n\n').repeat(Math.ceil(kb * 1024 / 850))}`;

console.log('\x1b[1m\x1b[36m▸ compiler micro-stress — transformHost on pathological inputs\x1b[0m');
let detAll = true;
const row = (label: string, ms: number, extra = '') => console.log(`  ${label.padEnd(16)} p50 ${ms.toFixed(2).padStart(8)}ms   ${extra}`);

console.log('\n  islands (count) — expect ~O(n^1.7):');
const islMs: Record<number, number> = {};
for (const n of [1, 10, 50, 100, 200]) { const r = time(manyIslands(n), `/s/i${n}.svelte`); detAll &&= r.det; islMs[n] = r.ms; row(`islands×${n}`, r.ms, `${(r.ms / n).toFixed(3)} ms/island`); }

console.log('\n  nesting (depth) — was O(2^depth), fixed to linear (guard: per-level ≈ 1×):');
const nestMs: number[] = [];
for (const d of [2, 4, 6, 8, 10, 12]) { const r = time(nest(d), `/s/n${d}.svelte`); detAll &&= r.det; nestMs.push(r.ms); row(`nest depth ${d}`, r.ms); }

console.log('\n  content (kB) — expect linear:');
for (const kb of [10, 100, 500]) { const r = time(content(kb), `/s/c${kb}.svelte`); detAll &&= r.det; row(`content ${kb}kB`, r.ms, `${(kb / r.ms).toFixed(0)} kB/ms`); }

// guards: island super-linearity within bound, nesting per-level ratio flagged, determinism holds.
const islScale = islMs[200] / islMs[100]; // 2× input → time factor; ~2 linear, >4 = quadratic
const nestPerLevel = Math.pow(nestMs[nestMs.length - 1] / Math.max(nestMs[1], 0.01), 1 / (12 - 4)); // per-depth factor over 4..12
console.log(`\n  islands 100→200 = ${islScale.toFixed(1)}× time (${islScale < 4 ? '\x1b[32msub-quadratic ✓' : '\x1b[31mquadratic ✗'}\x1b[0m)`);
console.log(`  nesting per-level factor ≈ ${nestPerLevel.toFixed(2)}× ${nestPerLevel > 1.4 ? '\x1b[31m(EXPONENTIAL — nested islands re-transform inner subtree; fix candidate) ✗' : '\x1b[32m(linear-ish) ✓'}\x1b[0m`);
console.log(`  determinism: ${detAll ? '\x1b[32mPASS ✓' : '\x1b[31mFAIL ✗'}\x1b[0m`);
if (!detAll) process.exitCode = 1;
