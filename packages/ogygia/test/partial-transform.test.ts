// Held-region transform suite. A held region is a marked import handed to `region()`:
//   - `.svelte` host: `with { region: 'raw' }` (a `wake:` mark there is a PLACED island, not held).
//   - `.ts` registry / remote: `with { region: 'raw' }` (no baked schedule) OR `with { wake: '…' }`
//     (baked schedule) — a `.ts` module has no template, so every marked import there is held.
// Both register a server island (server:true, kind:'hydrate' — a held region always ships a client
// chunk; it just isn't fetched unless woken) and rewrite the host import to the leg-split descriptor
// module. Runs against built `../dist`.

import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
	transformHost,
	transformTsRegions,
	regionIdentity,
	regionId,
	regionBindingVirtualId
} from '../dist/vite/transform.js';

const ROOT = '/app';

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_hostId: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_hostId: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
		devUrlFor: (p: string) => '/@id/' + p,
		visibleMargin: '0px',
		presets: {},
		...overrides
	};
}

// A held descriptor's id encodes its baked schedule: `region:raw` (no schedule) vs `region:visible`.
function heldId(compRel: string, hydrate?: string) {
	const options: Record<string, unknown> = {};
	if (hydrate) {
		options.hydrate = hydrate;
		if (hydrate === 'visible') options.hydrateMargin = '0px';
	}
	return regionId(regionIdentity(compRel, { strategy: 'held', options }));
}

describe('transformHost — held region in .svelte (region: raw)', () => {
	const src = `<script>
		import Card from '$lib/Card.svelte' with { region: 'raw' };
		import { region } from 'ogygia';
		export const f = region(Card, { id: 1 });
	</script>`;

	test('registers a server descriptor and rewrites the import to the binding module', () => {
		const r = transformHost(src, '/app/src/routes/+page.svelte', makeCtx());
		expect(r).not.toBeNull();
		const iid = heldId('src/lib/Card.svelte');
		expect(r!.islands).toHaveLength(1);
		const isl = r!.islands[0] as Record<string, unknown>;
		expect(isl.id).toBe(iid);
		expect(isl.server).toBe(true);
		expect(isl.kind).toBe('hydrate');
		expect(isl.held).toBe(true);
		expect(isl.bindingPath).toBe(regionBindingVirtualId(iid));
		expect(String(isl.bindingSsrSource)).toContain('makeRegionEndpoint');
		// region:'raw' bakes NO schedule — the descriptor carries a chunk but no __hydrate.
		expect(String(isl.bindingSsrSource)).not.toContain('__hydrate');
		expect(String(isl.bindingSsrSource)).not.toContain('__module: ""');
		expect(String(isl.bindingClientSource)).not.toContain('makeRegionEndpoint');
		// host import now points at the leg-split binding module, attribute stripped
		expect(r!.code).toContain(`import Card from "${regionBindingVirtualId(iid)}"`);
		expect(r!.code).not.toContain('with {');
	});

	test('rejects region combined with another import attribute', () => {
		const bad = `<script>
			import Card from '$lib/Card.svelte' with { region: 'raw', wake: 'load' };
		</script>`;
		expect(() => transformHost(bad, '/app/src/routes/+page.svelte', makeCtx())).toThrow(
			/must be the only import attribute/
		);
	});

	test("rejects a region value other than 'raw'", () => {
		const bad = `<script>
			import Card from '$lib/Card.svelte' with { region: 'load' };
		</script>`;
		expect(() => transformHost(bad, '/app/src/routes/+page.svelte', makeCtx())).toThrow(
			/only takes the value 'raw'/
		);
	});

	// The retired `partial:` key throws a pointer to its replacement — but only when the host also
	// carries a live region key (the cheap source-scan skips a file whose ONLY marker is retired).
	test('the retired `partial:` key throws when alongside a live region import', () => {
		const bad = `<script>
			import Card from '$lib/Card.svelte' with { partial: 'load' };
			import Live from '$lib/Live.svelte' with { region: 'raw' };
		</script>`;
		expect(() => transformHost(bad, '/app/src/routes/+page.svelte', makeCtx())).toThrow(
			/`partial` import attribute was retired/
		);
	});
});

describe('transformTsRegions — held region in .ts', () => {
	const id = '/app/src/lib/cards.remote.ts';

	test('region: raw registers a no-schedule descriptor and strips the attribute', () => {
		const src = `import Card from './Card.svelte' with { region: 'raw' };
import { query } from '$app/server';
export const loadCard = query(async (n) => region(Card, { id: n }));`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r).not.toBeNull();
		const iid = heldId('src/lib/Card.svelte');
		expect(r!.islands).toHaveLength(1);
		const isl = r!.islands[0] as Record<string, unknown>;
		expect(isl.id).toBe(iid);
		expect(isl.server).toBe(true);
		expect(isl.kind).toBe('hydrate');
		expect(String(isl.bindingSsrSource)).not.toContain('__hydrate');
		expect(r!.code).toContain(`import Card from "${regionBindingVirtualId(iid)}"`);
		expect(r!.code).not.toContain('with {');
	});

	// A `wake:` mark on a `.ts` held import bakes its schedule (same axis + defaults as a placed island).
	for (const [value, hydrate] of [
		['load', 'load'],
		['idle', 'idle'],
		['visible', 'visible'],
		['(max-width: 500px)', '(max-width: 500px)']
	] as const) {
		test(`wake: '${value}' bakes __hydrate ${hydrate}`, () => {
			const s = `import C from './C.svelte' with { wake: '${value}' };
export const f = region(C, {});`;
			const r = transformTsRegions(s, id, makeCtx());
			const isl = r!.islands[0] as Record<string, unknown>;
			expect(isl.kind).toBe('hydrate');
			expect(isl.server).toBe(true);
			expect(String(isl.bindingSsrSource)).toContain(`__hydrate: ${JSON.stringify(hydrate)}`);
			// distinct schedules mint distinct ids (and differ from a raw descriptor)
			expect(isl.id).toBe(heldId('src/lib/C.svelte', hydrate));
			expect(isl.id).not.toBe(heldId('src/lib/C.svelte'));
		});
	}

	test('wake: visible bakes a hydrate margin (from ctx.visibleMargin)', () => {
		const s = `import C from './C.svelte' with { wake: 'visible' };
export const f = region(C, {});`;
		const r = transformTsRegions(s, id, makeCtx({ visibleMargin: '200px' }));
		expect(String((r!.islands[0] as Record<string, unknown>).bindingSsrSource)).toContain(
			'__hydrateMargin: "200px"'
		);
	});

	test('rejects an unknown wake value', () => {
		const bad = `import C from './C.svelte' with { wake: 'sometimes' };`;
		expect(() => transformTsRegions(bad, id, makeCtx())).toThrow(/unknown .*wake.* strategy/);
	});

	test('a .svelte region:raw and a .ts region:raw of the same component share one id', () => {
		const svelteId = heldId('src/lib/Card.svelte');
		const src = `import Card from '$lib/Card.svelte' with { region: 'raw' };
export const loadCard = region(Card, {});`;
		const r = transformTsRegions(src, id, makeCtx());
		expect((r!.islands[0] as Record<string, unknown>).id).toBe(svelteId);
	});

	test('returns null when no held import is present', () => {
		expect(transformTsRegions(`export const x = 1;`, id, makeCtx())).toBeNull();
	});
});
