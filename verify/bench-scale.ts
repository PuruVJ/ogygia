// ─────────────────────────────────────────────────────────────────────────────
// ogygia SCALE bench — stress the two things that actually grow with a big app:
//   A. TRANSFORM: thousands of hosts × many island imports (varied schedules) → the plugin's
//      per-host parse + rewrite + island dedup.
//   B. CONTENT: a collection with MILLIONS of entries → catalog build, get()/ids()/entries().
//
//   node verify/bench-scale.ts                 # default scale (fast, ~seconds)
//   node verify/bench-scale.ts --huge          # millions of content entries + 5k hosts
//   HOSTS=2000 ISLANDS=12 ENTRIES=1000000 node verify/bench-scale.ts
//
// Appends a row to perf-checkpoints.md (## scale).
// ─────────────────────────────────────────────────────────────────────────────
import { transformHost } from '../packages/ogygia/dist/vite/transform.js';
import { content } from '../packages/ogygia/dist/content/factory.js';
import { fromArray } from '../packages/ogygia/dist/content/source.js';
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const huge = process.argv.includes('--huge');
const HOSTS = Number(process.env.HOSTS || (huge ? 5000 : 800));
const ISLANDS = Number(process.env.ISLANDS || 10);
const DISTINCT = Number(process.env.DISTINCT || 60);
const ENTRIES = Number(process.env.ENTRIES || (huge ? 2_000_000 : 200_000));
const label = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || (huge ? 'huge' : 'default');

const mb = () => Math.round(process.memoryUsage().heapUsed / 1e6);
const ms = (t: number) => `${t.toFixed(0)}ms`;

const ctx = {
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
	devUrlFor: (p: string) => '/@id/' + p,
	visibleMargin: '0px',
	presets: {}
};

// deterministic pseudo-random (no Math.random in some contexts; also reproducible)
let seed = 123456789;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

const SCHEDULES = [
	`wake: 'load'`,
	`wake: 'idle'`,
	`wake: 'visible'`,
	`wake: 'interaction'`,
	`wake: 'none'`,
	`render: 'deferred'`,
	`render: 'deferred', wake: 'visible'`
];

/** One synthetic host: DISTINCT-pool imports w/ varied schedules + usages (dedup + each-loops). */
function makeHost(i: number): string {
	const imports: string[] = [`const rows = Array.from({length: 8}, (_, k) => k);`];
	const usages: string[] = [];
	const n = ISLANDS;
	for (let j = 0; j < n; j++) {
		const comp = `C${Math.floor(rnd() * DISTINCT)}`;
		const local = `I${j}`;
		imports.push(`import ${local} from '$lib/${comp}.svelte' with { ${pick(SCHEDULES)} };`);
		// mix single usage, repeated usage (dedup), and each-loop usage
		const kind = Math.floor(rnd() * 3);
		if (kind === 0) usages.push(`<${local} n={${j}} />`);
		else if (kind === 1) usages.push(`<${local} n={1} /><${local} n={2} />`);
		else usages.push(`{#each rows as r}<${local} v={r} />{/each}`);
	}
	return `<script>\n${imports.join('\n')}\n</script>\n${usages.join('\n')}`;
}

console.log(`\n▸ SCALE bench  [${label}]  hosts=${HOSTS} islands/host=${ISLANDS} distinct=${DISTINCT} entries=${ENTRIES.toLocaleString()}`);

// ── A. TRANSFORM at scale ────────────────────────────────────────────────────
const hosts: string[] = [];
for (let i = 0; i < HOSTS; i++) hosts.push(makeHost(i));

const idsSeen = new Set<string>();
let islandCount = 0;
const tA0 = performance.now();
for (let i = 0; i < HOSTS; i++) {
	const r = transformHost(hosts[i], `/app/src/routes/r${i}/+page.svelte`, ctx);
	if (r) {
		islandCount += r.islands.length;
		for (const isl of r.islands) idsSeen.add(isl.id);
	}
}
const tA = performance.now() - tA0;
console.log(`\n  A. transform ${HOSTS} hosts`);
console.log(`     total ${ms(tA)}  ·  ${(HOSTS / (tA / 1000)).toFixed(0)} hosts/s  ·  ${(tA / HOSTS * 1000).toFixed(0)}µs/host`);
console.log(`     islands emitted ${islandCount.toLocaleString()}  ·  distinct chunks ${idsSeen.size.toLocaleString()}  ·  dedupe ${(1 - idsSeen.size / islandCount).toFixed(2)}x`);

// ── B. CONTENT at scale ──────────────────────────────────────────────────────
console.log(`\n  B. content collection, ${ENTRIES.toLocaleString()} entries`);
// Build a lazy generator `from` so we never hold a giant literal array before the collection does.
function* gen() {
	for (let i = 0; i < ENTRIES; i++) {
		yield { id: `e${i}`, data: { title: `Item ${i}`, tag: i % 100, n: i } };
	}
}
const memBefore = mb();
const col = content({ loader: fromArray([...gen()]) });

const tIds0 = performance.now();
const ids = await col.ids(); // triggers catalog build
const tIds = performance.now() - tIds0;
console.log(`     build+ids() ${ms(tIds)}  ·  ${ids.length.toLocaleString()} ids  ·  heap +${mb() - memBefore}MB`);

// random get() latency
const tGet0 = performance.now();
const N_GET = 100_000;
let hit = 0;
for (let i = 0; i < N_GET; i++) {
	const e = await col.get(`e${Math.floor(rnd() * ENTRIES)}`);
	if (e) hit++;
}
const tGet = performance.now() - tGet0;
console.log(`     ${N_GET.toLocaleString()} random get() ${ms(tGet)}  ·  ${(tGet / N_GET * 1000).toFixed(2)}µs/get  ·  hits ${hit.toLocaleString()}`);

const tEnt0 = performance.now();
const all = await col.entries();
const tEnt = performance.now() - tEnt0;
console.log(`     entries() (materialize all) ${ms(tEnt)}  ·  ${all.length.toLocaleString()} rows  ·  heap ${mb()}MB`);

// ── C. CONTENT GRAPH at scale (relations + backlink inversion) ────────────────
const G = Math.min(ENTRIES, huge ? 500_000 : 50_000);
console.log(`\n  C. content graph, ${G.toLocaleString()} posts → authors (backlink target)`);
const authors = content({
	loader: fromArray(Array.from({ length: G }, (_, i) => ({ id: `a${i}`, data: { name: `A${i}` } })))
});
const posts = content({
	loader: fromArray(
		Array.from({ length: G }, (_, i) => ({ id: `p${i}`, data: { title: `P${i}`, author: `a${i % G}` } }))
	),
	relations: () => ({ author: authors })
});
await posts.ids();
const tBl0 = performance.now();
const N_BL = 50_000;
for (let i = 0; i < N_BL; i++) await authors.get(`a${Math.floor(rnd() * G)}`);
const tBl = performance.now() - tBl0;
console.log(`     ${N_BL.toLocaleString()} get() on backlink target ${ms(tBl)}  ·  ${(tBl / N_BL * 1000).toFixed(2)}µs/get (amortized; index built once/version)`);

// ── record ───────────────────────────────────────────────────────────────────
const file = path.join(repo, 'perf-checkpoints.md');
const header = '\n## scale\n\n| label | hosts | islands | content entries | transform ms | hosts/s | build+ids ms | get µs | backlink µs | entries ms | heap MB |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
if (!existsSync(file)) writeFileSync(file, '# ogygia perf checkpoints\n');
const hasScaleSection = existsSync(file) && readFileSync(file, 'utf-8').includes('## scale');
if (!hasScaleSection) appendFileSync(file, header);
appendFileSync(
	file,
	`| ${label} | ${HOSTS} | ${islandCount} | ${ENTRIES} | ${tA.toFixed(0)} | ${(HOSTS / (tA / 1000)).toFixed(0)} | ${tIds.toFixed(0)} | ${(tGet / N_GET * 1000).toFixed(2)} | ${(tBl / N_BL * 1000).toFixed(2)} | ${tEnt.toFixed(0)} | ${mb()} |\n`
);
console.log(`\n✓ scale checkpoint '${label}' appended to perf-checkpoints.md\n`);
