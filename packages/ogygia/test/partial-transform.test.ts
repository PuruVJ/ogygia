// Region transform suite for `.ts` registries / remotes. Two markers:
//   - `with { region: 'raw' }` → a bare HELD descriptor (server:true, no baked schedule) handed to
//     `region()`. `.svelte` `region: 'raw'` produces the same descriptor.
//   - `with { wake: '…' }` → a HELD binding that is ALSO MOUNTABLE (server:true + held, kind:'hydrate'):
//     placeable via `<svelte:component>` (renders the `<ogygia-region>` shell, JS gated on placement +
//     schedule) yet still crossable over the wire via `region()`. A superset of the old descriptor. It
//     keeps the `held:*` identity — distinct from a `.svelte` PLACED island (`hydrate:*`, no endpoint).
// Both rewrite the host import to the leg-split binding module. Runs against built `../dist`.

import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
	transformHost,
	transformTsRegions,
	regionIdentity,
	regionId,
	regionBindingVirtualId
} from '../dist/compiler/region/transform.js';

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

// A `.ts` held-region id: strategy 'held', its baked schedule → `region:raw` (no schedule) vs
// `region:visible`. A `.ts` `wake:` mark bakes the schedule but stays a HELD (crossable) island, so it
// keeps the `held:*` identity — distinct from a `.svelte` PLACED island (`hydrate:*`, no endpoint).
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

	test('a real import AFTER a backtick inside a string is still rewritten (AST guard, not backtick count)', () => {
		// The old unescaped-backtick parity heuristic counted this in-string backtick and WRONGLY skipped
		// the real import below it. The AST guard knows the backtick sits inside a string literal.
		const src = `const x = "a \` b";
import Card from './Card.svelte' with { region: 'raw' };
export const f = region(Card, {});`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r).not.toBeNull();
		expect(r!.islands).toHaveLength(1);
		expect(r!.code).toContain(
			`import Card from "${regionBindingVirtualId(heldId('src/lib/Card.svelte'))}"`
		);
	});

	test('a held-region import that is only TEXT inside a template literal is left alone', () => {
		const src =
			"export const sample = `import Fake from './Fake.svelte' with { region: 'raw' };`;\n";
		const r = transformTsRegions(src, id, makeCtx());
		expect(r).toBeNull(); // nothing real to rewrite
	});

	test('a held-region import inside a JSDoc @example COMMENT is left alone (regression: ogygia src/index.ts)', () => {
		const src = `/**
 * @example
 *   import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
 */
export const y = 1;`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r).toBeNull(); // the comment sample must NOT register a phantom island
	});

	// A `wake:` mark on a `.ts` registry bakes its schedule AND makes the binding MOUNTABLE — placeable
	// (Builder's `<svelte:component>`) yet still a HELD, crossable island (server:true + held) for
	// `region()` over the wire. A superset of the old descriptor-only shape.
	for (const [value, hydrate] of [
		['load', 'load'],
		['idle', 'idle'],
		['visible', 'visible'],
		['(max-width: 500px)', '(max-width: 500px)']
	] as const) {
		test(`wake: '${value}' → a mountable held binding (__hydrate ${hydrate})`, () => {
			const s = `import C from './C.svelte' with { wake: '${value}' };
export const f = region(C, {});`;
			const r = transformTsRegions(s, id, makeCtx());
			const isl = r!.islands[0] as Record<string, unknown>;
			expect(isl.kind).toBe('hydrate');
			expect(isl.strategy).toBe(hydrate);
			// HELD + crossable: keeps its server-manifest entry + the live/morph mark (so `region()` can
			// stream it over the wire), exactly like the old descriptor.
			expect(isl.server).toBe(true);
			expect(isl.held).toBe(true);
			// MOUNTABLE (the new bit): the binding is the wrapper component with the descriptor
			// Object.assign'd on, plus a wrapper `.svelte` that renders the `<ogygia-region>` shell.
			expect(String(isl.bindingSsrSource)).toContain('Object.assign(__OgygiaWrap');
			expect(String(isl.bindingSsrSource)).toContain('export default __OgygiaWrap');
			expect(String(isl.wrapperSource)).toContain('OgygiaRegion__Wrapper __mode="island"');
			// HOLDABLE: region() still reads the baked schedule + component + signer off the binding.
			expect(String(isl.bindingSsrSource)).toContain(`__hydrate: ${JSON.stringify(hydrate)}`);
			expect(String(isl.bindingSsrSource)).toContain('__component');
			expect(String(isl.bindingSsrSource)).toContain('makeRegionEndpoint');
			// Distinct schedules mint distinct ids; a `wake:` id differs from a raw descriptor.
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

describe('transformTsRegions — import.meta.og.asRegion (barrel / named in .ts)', () => {
	const id = '/app/src/lib/registry.ts';
	const isl0 = (r: ReturnType<typeof transformTsRegions>) =>
		r!.islands[0] as Record<string, unknown>;

	test('a NAMED barrel import → a mountable held binding (same record as a .ts wake mark)', () => {
		const src = `import { Header } from '@design/system';
const HeaderRegion = import.meta.og.asRegion(Header, { wake: 'visible' });
export const registry = [{ name: 'header', component: HeaderRegion }];`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r).not.toBeNull();
		expect(r!.islands).toHaveLength(1);
		const isl = isl0(r);
		// mountable + held (server:true) + the named export threaded through the entry + wrapper
		expect(isl.server).toBe(true);
		expect(isl.held).toBe(true);
		expect(String(isl.bindingSsrSource)).toContain('Object.assign(__OgygiaWrap');
		expect(String(isl.bindingSsrSource)).toContain('__hydrate: "visible"');
		expect(String(isl.source)).toMatch(
			/import \{ Header as __OgygiaComp_[0-9a-f]+ \} from ["']@design\/system["']/
		);
		// the const is rewritten to a hoisted binding import; the macro is gone
		expect(r!.code).toMatch(
			new RegExp(
				`import HeaderRegion from ["']${regionBindingVirtualId(isl.id as string).replace(/\./g, '\\.')}["']`
			)
		);
		expect(r!.code).not.toContain('import.meta.og.asRegion');
		// identity keys on source#exportName
		expect(isl.id).toBe(
			regionId(
				regionIdentity('@design/system#Header', {
					strategy: 'held',
					options: { hydrate: 'visible', hydrateMargin: '0px' }
				})
			)
		);
	});

	test('region: raw via asRegion → a bare held descriptor with the named import', () => {
		const src = `import { Block } from '@design/system';
const BlockRegion = import.meta.og.asRegion(Block, { region: 'raw' });
export const f = () => region(BlockRegion, {});`;
		const r = transformTsRegions(src, id, makeCtx());
		const isl = isl0(r);
		expect(isl.server).toBe(true);
		expect(String(isl.bindingSsrSource)).toContain('export default {');
		expect(String(isl.bindingSsrSource)).not.toContain('Object.assign');
		expect(String(isl.source)).toMatch(
			/import \{ Block as __OgygiaComp_[0-9a-f]+ \} from ["']@design\/system["']/
		);
	});

	test('a DEFAULT import works via asRegion in .ts too', () => {
		const src = `import Card from './Card.svelte';
const CardRegion = import.meta.og.asRegion(Card, { wake: 'load' });
export const registry = [CardRegion];`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r!.islands).toHaveLength(1);
		expect(String(isl0(r).source)).toMatch(
			/import __OgygiaComp_[0-9a-f]+ from ["'][^"']*Card\.svelte["']/
		);
	});

	test('two named exports of one barrel → two distinct islands', () => {
		const src = `import { Header, Footer } from '@design/system';
const H = import.meta.og.asRegion(Header, { wake: 'load' });
const F = import.meta.og.asRegion(Footer, { wake: 'load' });
export const registry = [H, F];`;
		const r = transformTsRegions(src, id, makeCtx());
		expect(r!.islands).toHaveLength(2);
		expect(new Set(r!.islands.map((i) => (i as Record<string, unknown>).id)).size).toBe(2);
	});

	// ── misuse (loud build errors) ──────────────────────────────────────────────
	test('first arg not an imported component → error', () => {
		expect(() =>
			transformTsRegions(
				`const X = import.meta.og.asRegion(Nope, { wake: 'load' });`,
				id,
				makeCtx()
			)
		).toThrow(/not an imported component/);
	});
	test('namespace import → error', () => {
		expect(() =>
			transformTsRegions(
				`import * as UI from '@d/s';\nconst X = import.meta.og.asRegion(UI, { wake: 'load' });`,
				id,
				makeCtx()
			)
		).toThrow(/namespace import/);
	});
	test('NOT top-level (nested in a function) → error', () => {
		expect(() =>
			transformTsRegions(
				`import { H } from '@d/s';\nfunction f() { const X = import.meta.og.asRegion(H, { wake: 'load' }); return X; }`,
				id,
				makeCtx()
			)
		).toThrow(/must be a top-level/);
	});
	test('unknown option key → error', () => {
		expect(() =>
			transformTsRegions(
				`import { H } from '@d/s';\nconst X = import.meta.og.asRegion(H, { render: 'deferred' });`,
				id,
				makeCtx()
			)
		).toThrow(/unknown option/);
	});
	test('a string shorthand is rejected (options must be an object)', () => {
		expect(() =>
			transformTsRegions(
				`import { H } from '@d/s';\nconst X = import.meta.og.asRegion(H, 'load');`,
				id,
				makeCtx()
			)
		).toThrow(/needs an options object/);
	});
});
