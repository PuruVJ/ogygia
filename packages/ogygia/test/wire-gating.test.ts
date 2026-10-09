/**
 * REGRESSION NET for the wire-feature gating (the "Unknown type OgygiaRef" class of failure).
 *
 * The runtime's hub revivers (every wired value — crossing snippets/slots, classes, stores — decodes
 * under the ONE `OgygiaRef` devalue type) ship only when the build marks `wire`. The server encoder
 * is NOT gated: it serializes whatever the render actually crosses. So the invariant is
 *
 *     whatever the server can encode into a page, the selected runtime can revive
 *
 * and every hole in the compile-time detection is a production app whose islands ALL fail to
 * hydrate with "Unknown type OgygiaRef" (seen in the wild: a component-factory registry placed the
 * carousel/footer islands dynamically — no static `<Tag>` for the children check to see — and the
 * usage-gated runtime shipped without the hub; every island on the deployed page was dead).
 *
 * The design is ONE flag: each compilation answers "can this file cross live content into an
 * island?" (`hasWireCrossing`) from its own evidence — static children, portable {#snippet},
 * dynamically-used wake binding, `.ts`-minted wake region — and program.register has ONE rule.
 * (The other evidence class, a transportable CLASS definition, is placement-independent and marked
 * in the driver's prescan — not covered here.)
 *
 * Pins the include legs — and, just as critically, the EXCLUDEs (the claw-back must survive):
 *   1. static placement with children        → wire
 *   2. wake binding with NO static use       → wire      (dynamic placement: registry/each/prop)
 *   3. `.ts`/`.js`-minted wake regions       → wire      (registries are dynamic by definition)
 *   4. static childless placement            → NO wire   (plain apps keep the lean runtime)
 *   5. defer/raw-only mints                  → NO wire   (isolation / data-minting never cross)
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
	transformHost,
	transformTsRegions,
	normalize_import_keys,
	wrapperVirtualId
} from '../src/compiler/region/transform.js';
import { Program } from '../src/compiler/program.js';
import { resolveFeatures } from '../src/compiler/link/runtime-entry.js';

const ctx = {
	root: '/app',
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_h: string, iid: string) => wrapperVirtualId(iid),
	devUrlFor: (p: string) => '/@id/' + p,
	visibleMargin: '0px',
	presets: {},
	importKeys: normalize_import_keys(undefined),
	idSalt: '',
	linkVirtualIsland: true,
	clientBindingStub: '',
	routeCsr: undefined,
	ssr: true
};

const HOST = '/app/src/routes/+page.svelte';
const wrap = (imports: string, markup: string) => `<script>\n${imports}\n</script>\n${markup}`;

function marks_for(source: string, hostId = HOST) {
	const program = new Program({ forms: false, router: false });
	const result = /\.svelte$/.test(hostId)
		? transformHost(source, hostId, ctx)
		: transformTsRegions(source, hostId, ctx);
	expect(result).not.toBeNull();
	program.register(result!, hostId);
	// The real prescan marks completion after walking every host; without it resolveFeatures stays
	// kitchen-sink (the safe default) and the exclude assertions would be meaningless.
	return { ...program.runtime_marks, complete: true };
}

describe('wire gating — the four detection legs', () => {
	it('static placement WITH children → wire (slot pointers cross)', () => {
		const marks = marks_for(
			wrap(`import C from './C.svelte' with { wake: 'load' };`, '<C><p>slotted</p></C>')
		);
		expect(marks.wire).toBe(true);
		expect(resolveFeatures(marks)).toContain('wire');
	});

	it('hydrate binding with NO static placement (registry/each/prop use) → wire', () => {
		// The binding is exported as a VALUE — placements (and their children) are compile-invisible.
		const marks = marks_for(
			wrap(
				`import C from './C.svelte' with { wake: 'visible' };\nexport const registry = { c: C };`,
				'<p>no static tag anywhere</p>'
			)
		);
		expect(marks.wire).toBe(true);
		expect(resolveFeatures(marks)).toContain('wire');
	});

	it('dynamic-only use via {#each}/svelte:component → wire', () => {
		const marks = marks_for(
			wrap(
				`import C from './C.svelte' with { wake: 'load' };\nconst comps = [C];`,
				`{#each comps as Comp}<svelte:component this={Comp} n={1} />{/each}`
			)
		);
		expect(marks.wire).toBe(true);
	});

	it('.ts-minted hydrate regions (the factory-registry pattern) → wire', () => {
		const marks = marks_for(
			`import Card from './Card.svelte' with { wake: 'visible' };\nexport const blocks = { card: Card };\n`,
			'/app/src/lib/registry.ts'
		);
		expect(marks.wire).toBe(true);
		expect(resolveFeatures(marks)).toContain('wire');
	});

	it('EXCLUDE: static childless placement stays lean (no wire)', () => {
		const marks = marks_for(
			wrap(`import C from './C.svelte' with { wake: 'load' };`, '<C n={1} /><C n={2} />')
		);
		expect(marks.wire).not.toBe(true);
		expect(resolveFeatures(marks)).not.toContain('wire');
	});

	it('EXCLUDE: an unplaced lake/server mark does not force wire', () => {
		const marks = marks_for(
			wrap(
				`import S from './S.svelte' with { render: 'deferred' };`,
				'<S>{#snippet ogygiaFallback()}x{/snippet}</S>'
			)
		);
		expect(marks.wire).not.toBe(true);
	});

	it('EXCLUDE: a .ts registry of raw (held) regions stays lean — the blocks pattern', () => {
		const marks = marks_for(
			`import Card from './Card.svelte' with { region: 'raw' };\nexport const blocks = { card: Card };\n`,
			'/app/src/lib/blocks.ts'
		);
		expect(marks.wire).not.toBe(true);
	});

	it('EXCLUDE: a .ts registry of deferred (server) islands stays lean', () => {
		const marks = marks_for(
			`import Late from './Late.svelte' with { render: 'deferred' };\nexport const blocks = { late: Late };\n`,
			'/app/src/lib/server-blocks.ts'
		);
		expect(marks.wire).not.toBe(true);
	});
});
