/**
 * `ogygia({ regions: { preload } })` — which islands get `<link rel="modulepreload">` hints in
 * the SSR HTML. Default 'load': only islands that wake at load. 'all': every island, non-load ones
 * at `fetchpriority="low"` (the previous behaviour). 'none': no code hints at all.
 *
 * Region.svelte reads the policy from `virtual:ogygia/island-deps` (aliased to the test stub,
 * whose export is a LIVE binding flipped per test); the virtual module is minted with the policy
 * by `island_deps_module` (checked against the built output, like the other link tests).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { set_preload_policy } from './_stubs/virtual-island-deps.js';
import { island_deps_module } from '../dist/compiler/link/island-deps.js';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';

const region = Region as unknown as Component<Record<string, unknown>>;
const HINT_RE = /<link rel="modulepreload" href="\/islands\/tiny\.js"( fetchpriority="low")?>/g;

/** Render one placed island with the given wake flag; return its hints (0, 1) and their priority. */
function hints(wake: 'load' | 'visible' | 'interaction' | 'idle') {
	const props: Record<string, unknown> = { __mode: 'island', __entry: '/islands/tiny.js', __component: Tiny, __props: {} };
	if (wake !== 'load') props[wake] = true;
	const out = render(region, { props });
	const html = out.head + out.body;
	const found = [...html.matchAll(HINT_RE)];
	return { count: found.length, low: found.some((m) => !!m[1]), html };
}

afterEach(() => set_preload_policy('load'));

describe('regions.preload — placed islands', () => {
	it("'load' (default): a load island is hinted at normal priority, nothing else is", () => {
		expect(hints('load')).toMatchObject({ count: 1, low: false });
		expect(hints('visible').count).toBe(0);
		expect(hints('interaction').count).toBe(0);
		expect(hints('idle').count).toBe(0);
	});

	it("'all': every island is hinted — load at normal priority, visible/interaction at fetchpriority=low", () => {
		set_preload_policy('all');
		expect(hints('load')).toMatchObject({ count: 1, low: false });
		expect(hints('visible')).toMatchObject({ count: 1, low: true });
		expect(hints('interaction')).toMatchObject({ count: 1, low: true });
		// idle was never hinted (its wake is soon anyway; a hint would be a blind bet on timing)
		expect(hints('idle').count).toBe(0);
	});

	it("'none': no code hint for anyone, the load island included", () => {
		set_preload_policy('none');
		expect(hints('load').count).toBe(0);
		expect(hints('visible').count).toBe(0);
		expect(hints('interaction').count).toBe(0);
	});

	it('the region itself renders the same under every policy — only the hint differs', () => {
		// drop the hint AND the per-render slot ids (`<!--45h-->`), which differ between renders
		const strip = (h: string) => h.replace(HINT_RE, '').replace(/<!--[a-z0-9]+-->/g, '');
		const a = strip(hints('visible').html);
		set_preload_policy('all');
		const b = strip(hints('visible').html);
		set_preload_policy('none');
		const c = strip(hints('visible').html);
		expect(a).toBe(b);
		expect(a).toBe(c);
		expect(a).toContain('<ogygia-region entry="/islands/tiny.js" wake="visible"');
		expect(a).toContain('<b data-tiny="">tiny</b>');
	});
});

describe('regions.preload — the minted virtual module', () => {
	it('exports the policy on every leg (client stub, dev, prod), default load', () => {
		for (const [ssr, dev] of [
			[false, false],
			[true, true],
			[true, false]
		] as const) {
			expect(island_deps_module(ssr, dev)).toContain('export const preloadPolicy = "load";');
			expect(island_deps_module(ssr, dev, '.svelte-kit', 'all')).toContain('export const preloadPolicy = "all";');
			expect(island_deps_module(ssr, dev, '.svelte-kit', 'none')).toContain('export const preloadPolicy = "none";');
		}
	});
});
