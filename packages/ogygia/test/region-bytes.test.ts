import { describe, expect, it } from 'vitest';
import { island_subgraph_bytes, type ByteGraphModule } from '../dist/compiler/dev/region-bytes.js';

/** Build a mock Vite dev-graph node. `code` sets `transformResult.code`; `imports` the downward edges. */
function mod(
	url: string,
	code: string | null,
	imports: ByteGraphModule[] = [],
	file?: string
): ByteGraphModule {
	return {
		url,
		file: file ?? null,
		transformResult: code == null ? null : { code },
		importedModules: imports
	};
}

describe('island_subgraph_bytes', () => {
	it('sums the component + its child app modules, not the entry glue', () => {
		const child = mod('/src/lib/Child.svelte', 'x'.repeat(100));
		const comp = mod('/src/lib/Counter.svelte', 'y'.repeat(200), [child]);
		const entry = mod('/@id/virtual:ogygia/island/abc123.js', 'glue', [comp]);
		const out = island_subgraph_bytes([entry]);
		expect(out.abc123).toEqual({ bytes: 300, modules: 2 }); // component + child, NOT the entry glue
	});

	it('prunes the framework (svelte / ogygia runtime) — shared once per page, not per island', () => {
		const svelte = mod('/node_modules/svelte/src/internal.js', 'z'.repeat(9999));
		const runtime = mod('/@fs/repo/packages/ogygia/dist/runtime/core.js', 'r'.repeat(9999));
		const comp = mod('/src/lib/Counter.svelte', 'y'.repeat(200), [svelte, runtime]);
		const entry = mod('/@id/virtual:ogygia/island/abc123.js', 'glue', [comp]);
		const out = island_subgraph_bytes([entry]);
		expect(out.abc123.bytes).toBe(200); // only Counter.svelte
	});

	it('prunes the shared transportables registry (would otherwise drag in the whole app)', () => {
		// The real bug: the island entry imports `virtual:ogygia/transportables`, which imports every
		// transportable-defining module app-wide (an 80 KB snippets file, the Observatory driver, …).
		const snippets = mod('/src/lib/code/snippets.ts', 'B'.repeat(80000));
		const registry = mod('/@id/virtual:ogygia/transportables', 'reg', [snippets]);
		const comp = mod('/src/lib/Counter.svelte', 'y'.repeat(200));
		const entry = mod('/@id/virtual:ogygia/island/abc123.js', 'glue', [comp, registry]);
		const out = island_subgraph_bytes([entry]);
		expect(out.abc123.bytes).toBe(200); // snippets stays out
	});

	it('ignores non-island modules and cold (untransformed) modules', () => {
		const cold = mod('/src/lib/Cold.svelte', null); // never transformed → no bytes
		const entry = mod('/@id/virtual:ogygia/island/cold01.js', 'glue', [cold]);
		const page = mod('/src/routes/+page.svelte', 'p'.repeat(500)); // not an island entry
		const out = island_subgraph_bytes([entry, page]);
		expect(out.cold01).toBeUndefined(); // nothing countable → island omitted
		expect(Object.keys(out)).toHaveLength(0);
	});

	it('keeps the larger subgraph when two graph nodes share one island id (?v= variants)', () => {
		const small = mod('/@id/virtual:ogygia/island/dad123.js', 'g', [
			mod('/src/A.svelte', 'a'.repeat(10))
		]);
		const big = mod('/@id/virtual:ogygia/island/dad123.js?v=2', 'g', [
			mod('/src/A.svelte', 'a'.repeat(50))
		]);
		const out = island_subgraph_bytes([small, big]);
		expect(out.dad123.bytes).toBe(50);
	});
});
