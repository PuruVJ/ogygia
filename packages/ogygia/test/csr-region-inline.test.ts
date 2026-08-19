// csr=true route hosts get a bare `setContext(Symbol.for('ogygia.csr-true'), true)` injected, so a
// `<Region>` in the page's subtree renders INLINE in the Kit tree instead of an `<ogygia-region>`
// mini-app. The injected Symbol string MUST match context.ts `CSR_TRUE_KEY` (the CSR-KEY contract)
// or Region's isCsrTrue() reads a different key and the boundary silently leaks — the assertion
// below is that contract, at the compiler layer (the region-mixed e2e proves it end to end).

import { describe, expect, it } from 'vitest';
import { transformHost } from '../dist/compiler/transform.js';

// The injected call aliases setContext; what must be locked is the Symbol key string + `, true`.
const CSR_CTX = /Symbol\.for\(\s*['"]ogygia\.csr-true['"]\s*\)\s*,\s*true\s*\)/;

describe('csr=true host: csr-context injection', () => {
	it('injects the csr marker into a MARKER-LESS host that only uses <Region>', () => {
		const src = `<script>\n\timport RegionInside from '$lib/RegionInside.svelte';\n</script>\n<RegionInside />`;
		const out = transformHost(src, '/app/src/routes/kit/+page.svelte', { routeCsr: true });
		expect(out).not.toBeNull();
		expect(out.code).toMatch(CSR_CTX);
		// bare svelte setContext — NOT an ogygia import (a region-less csr=true page ships zero ogygia)
		expect(out.code).toMatch(/from\s*['"]svelte['"]/);
		expect(out.code).not.toMatch(/from\s*['"]ogygia/);
		expect(out.islands).toEqual([]);
	});

	it('strips marked imports AND injects the csr marker', () => {
		const src = `<script>\n\timport Counter from '$lib/Counter.svelte' with { wake: 'load' };\n</script>\n<Counter />`;
		const out = transformHost(src, '/app/src/routes/kit/+page.svelte', { routeCsr: true });
		expect(out).not.toBeNull();
		// the `with { wake: 'load' }` attribute is gone → a plain Kit import
		expect(out.code).not.toContain('wake:');
		expect(out.code).toContain("import Counter from '$lib/Counter.svelte'");
		expect(out.code).toMatch(CSR_CTX);
		expect(out.islands).toEqual([]);
	});

	it('creates an instance <script> when the host has none', () => {
		const out = transformHost(`<h1>no script here</h1>`, '/app/src/routes/kit/+page.svelte', { routeCsr: true });
		expect(out).not.toBeNull();
		expect(out.code).toMatch(/<script>[\s\S]*setContext[\s\S]*<\/script>/);
		expect(out.code).toContain('<h1>no script here</h1>');
	});

	it('does NOT inject on a non-csr host (returns null for a plain component)', () => {
		const out = transformHost(`<script>\n\tlet x = 1;\n</script>\n<p>{x}</p>`, '/app/src/lib/Plain.svelte', { routeCsr: undefined });
		expect(out).toBeNull();
	});
});
