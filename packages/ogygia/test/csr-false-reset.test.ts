// REGRESSION: csr-true context INHERITANCE. Kit's csr option is per-node, but the transform's
// csr-marker is Svelte context, which flows to ALL descendants. An option-less ROOT layout (Kit
// default csr=true) injects `true`; a `csr = false` CHILD layout's islands then read the inherited
// `true` (isCsrTrue) and silently degrade to INLINE — zero <ogygia-region> on a page whose own csr is
// false. Real-world shape: se-web-platform's root layout (no csr export) above the [language] layout
// (csr=false) — every wake:'load' island in the [language] subtree rendered inline, no hydration.
// FIX: a csr=false route host injects a `false` RESET marker (CSR_FALSE_INJECT), shadowing the
// ancestor exactly like Kit resolves options ({ ...parent, ...own }); a csr=true host BELOW the reset
// re-shadows with `true`, so mixing works in both directions.
import { describe, expect, it } from 'vitest';
import { transformHost } from '../dist/compiler/region/transform.js';
import path from 'node:path';

const CTX = (routeCsr: boolean | undefined) => ({
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (host: string, i: number) => `virtual:ogygia/region/${i}.js`,
	wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.js`,
	devUrlFor: (p: string) => p,
	visibleMargin: '200px',
	presets: {},
	importKeys: undefined,
	idSalt: '',
	linkVirtualIsland: true,
	clientBindingStub: 'virtual:ogygia/client-binding-stub',
	routeCsr,
	ssr: true
});

const RESET = `Symbol.for('ogygia.csr-true'), false`;
const TRUE_MARK = `Symbol.for('ogygia.csr-true'), true`;

describe('csr=false route hosts inject the csr-false reset marker', () => {
	it('island host: keeps its island AND injects the reset', () => {
		const src = `<script>\n\timport Widget from '$lib/Widget.svelte' with { wake: 'load' };\n</script>\n<Widget />`;
		const out = transformHost(src, '/app/src/routes/docs/+layout.svelte', CTX(false));
		expect(out).toBeTruthy();
		expect(out!.code).toContain(RESET); // the reset marker
		expect(out!.islands.length).toBe(1); // island kept (not stripped)
		expect(out!.code).not.toContain(TRUE_MARK);
	});

	it('island-less host: still injects the reset (its subtree may hold islands via shared components)', () => {
		const src = `<script>\n\tlet x = 1;\n</script>\n<p>{x}</p><slot />`;
		const out = transformHost(src, '/app/src/routes/docs/+layout.svelte', CTX(false));
		expect(out).toBeTruthy();
		expect(out!.code).toContain(RESET);
		expect(out!.islands.length).toBe(0);
	});

	it('script-less host: synthesizes one <script> carrying the reset', () => {
		const out = transformHost(`<h1>hi</h1><slot />`, '/app/src/routes/docs/+page.svelte', CTX(false));
		expect(out).toBeTruthy();
		expect(out!.code).toContain(RESET);
		expect(out!.code.match(/<script/g)!.length).toBe(1);
	});

	it('csr=true host still injects `true` (shadowing below a reset works)', () => {
		const src = `<script>\n\timport W from '$lib/Widget.svelte' with { wake: 'load' };\n</script>\n<W />`;
		const out = transformHost(src, '/app/src/routes/docs/user/+page.svelte', CTX(true));
		expect(out).toBeTruthy();
		expect(out!.code).toContain(TRUE_MARK);
		expect(out!.code).not.toContain(RESET);
		expect(out!.islands.length).toBe(0); // stripped — Kit hydrates
	});

	it('shared component (routeCsr undefined): no marker of either kind, islands kept', () => {
		const src = `<script>\n\timport W from '$lib/Widget.svelte' with { wake: 'load' };\n</script>\n<W />`;
		const out = transformHost(src, '/app/src/lib/Shell.svelte', CTX(undefined));
		expect(out).toBeTruthy();
		expect(out!.code).not.toContain(RESET);
		expect(out!.code).not.toContain(TRUE_MARK);
		expect(out!.islands.length).toBe(1);
	});
});
