import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { island_host_loaded, parse_ssr_hosts, ssr_hosts_handoff_path } from '../src/compiler/link/emit-gate.js';
import { host_key } from '../src/compiler/program.js';

// ─────────────────────────────────────────────────────────────────────────────
// The client-leg island emit gate. The prescan registers every marked import under src/ (both legs,
// same ids); the client leg must emit chunks only for islands whose HOST the server bundle actually
// contains. Regression: an app building a second route tree from the same source — the as-is build
// emitted the OTHER tree's boot islands, which imported a `.remote.ts` the server leg never analysed
// → Kit: "Expected to find metadata for remote file", build failed.
// ─────────────────────────────────────────────────────────────────────────────

const root = '/app';
const loaded = new Set([host_key(join(root, 'src/routes/+page.svelte')), host_key(join(root, 'src/lib/Host.svelte'))]);

describe('island_host_loaded', () => {
	it('emits an island whose host the server leg transformed', () => {
		expect(island_host_loaded(join(root, 'src/routes/+page.svelte'), loaded)).toBe(true);
		// ids may carry a query / be unnormalised — same key rule as the registry
		expect(island_host_loaded(join(root, 'src/lib/Host.svelte') + '?og-region', loaded)).toBe(true);
	});

	it('skips an island whose host nothing in the server bundle imports', () => {
		expect(island_host_loaded(join(root, 'src/routes-v2/+page.svelte'), loaded)).toBe(false);
		expect(island_host_loaded(join(root, 'src/lib/pes-v2/ProductBoot.svelte'), loaded)).toBe(false);
	});

	it('without a handoff (standalone / client-only build) every prescanned island is emitted', () => {
		expect(island_host_loaded(join(root, 'src/routes-v2/+page.svelte'), null)).toBe(true);
		expect(island_host_loaded(join(root, 'src/routes-v2/+page.svelte'), undefined)).toBe(true);
	});

	it('an island with no recorded host (bridge-registered library island) is always emitted', () => {
		expect(island_host_loaded(null, loaded)).toBe(true);
		expect(island_host_loaded(undefined, loaded)).toBe(true);
	});
});

describe('the handoff file', () => {
	it('lives under Kit outDir and round-trips the server leg set', () => {
		expect(ssr_hosts_handoff_path('/app/.svelte-kit-v2')).toBe('/app/.svelte-kit-v2/og-ssr-hosts.json');
		const set = parse_ssr_hosts(JSON.stringify([...loaded].sort()));
		expect(set).toEqual(loaded);
	});

	it('tolerates a malformed handoff (nothing gated, never a throw on shape)', () => {
		expect(parse_ssr_hosts('{"not":"an array"}').size).toBe(0);
		expect(parse_ssr_hosts('[1, null, "/a/b.svelte"]')).toEqual(new Set(['/a/b.svelte']));
	});
});
