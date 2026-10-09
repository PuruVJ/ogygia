// link/registry-stub.ts — the names-only stub a csr=false route host imports instead of a region
// registry on the client leg of a build (Kit would otherwise link every registry component's CSS).
import { describe, expect, test } from 'vitest';
import {
	export_names,
	imported_names,
	is_registry_stub_id,
	registry_stub_id,
	registry_stub_names,
	registry_stub_source,
	registry_client_id,
	registry_client_path,
	registry_client_source,
	static_script_specs,
	REGISTRY_CLIENT_QUERY
} from '../src/compiler/link/registry-stub.js';

const REGISTRY = `
import Hero from './Hero.svelte' with { wake: 'visible' };
import Card from './Card.svelte' with { wake: 'visible' };
export const blocks = { hero: Hero, card: Card };
export function factory(type: string) { return blocks[type]; }
export class Registry {}
const internal = 1;
export { internal as exposed, Hero };
export default blocks;
`;

describe('export_names', () => {
	test('declarations, export lists (aliased), default', () => {
		expect([...export_names(REGISTRY)].sort()).toEqual(
			['Hero', 'Registry', 'blocks', 'default', 'exposed', 'factory'].sort()
		);
	});
	test('a module with no exports yields nothing', () => {
		expect(export_names(`const x = 1;`).size).toBe(0);
	});
});

describe('imported_names', () => {
	const HOST = `
<script lang="ts">
	import { blocks, factory as make } from '$lib/registry';
	import def from '$lib/registry';
	import * as ns from '$lib/other';
	import { unrelated } from '$lib/other';
	import type { T } from '$lib/registry';
</script>`;
	test('named (with alias → exported name) + default, only for the given spec', () => {
		expect([...imported_names(HOST, '$lib/registry')].sort()).toEqual(
			['T', 'blocks', 'default', 'factory'].sort()
		);
		expect([...imported_names(HOST, '$lib/other')]).toEqual(['unrelated']);
		expect(imported_names(HOST, '$lib/none').size).toBe(0);
	});
});

describe('stub id + source', () => {
	test('round-trips the names through the id; source declares each as undefined', () => {
		const id = registry_stub_id('src/lib/registry.ts', ['factory', 'default', 'blocks', 'blocks']);
		expect(is_registry_stub_id(id)).toBe(true);
		expect(is_registry_stub_id('\0' + id)).toBe(true);
		expect(is_registry_stub_id('virtual:ogygia/island/x.js')).toBe(false);
		expect(registry_stub_names('\0' + id)).toEqual(['blocks', 'default', 'factory']);
		const src = registry_stub_source(registry_stub_names(id));
		expect(src).toBe(
			'export const blocks = undefined;\nexport default undefined;\nexport const factory = undefined;\n'
		);
	});
	test('no names → an empty module', () => {
		expect(registry_stub_source([])).toBe('export {};\n');
	});
});

// The client-leg registry: the registry ITSELF with only its marks blanked, so its plain imports
// (rendered on the server, styled only through the page node's client graph) keep their edges.
describe('registry_client_source', () => {
	const KEYS = new Set(['wake', 'render', 'preset', 'region']);
	const FILE = '/app/src/lib/registry.ts';

	test('blanks marked imports, keeps plain ones, re-exports and style imports byte-for-byte', () => {
		const src = [
			`import Hero from './Hero.svelte' with { wake: 'visible' };`,
			`import Held from './Held.svelte' with { region: 'raw' };`,
			`import Hole from './Hole.svelte' with { render: 'deferred' };`,
			`import Heading from './Heading.svelte';`,
			`import { Banner } from './plain-barrel';`,
			`import './rows.css';`,
			`import type { Props } from './types';`,
			`export { default as Row } from './Row.svelte';`,
			`export const blocks = { hero: Hero, held: Held, hole: Hole, heading: Heading, banner: Banner };`
		].join('\n');
		const out = registry_client_source(src, FILE, KEYS)!;
		expect(out).toContain('const Hero = undefined;');
		expect(out).toContain('const Held = undefined;');
		expect(out).toContain('const Hole = undefined;');
		expect(out).not.toContain('Hero.svelte');
		expect(out).not.toContain('Held.svelte');
		expect(out).not.toContain('Hole.svelte');
		for (const kept of [
			`import Heading from './Heading.svelte';`,
			`import { Banner } from './plain-barrel';`,
			`import './rows.css';`,
			`import type { Props } from './types';`,
			`export { default as Row } from './Row.svelte';`,
			`export const blocks = { hero: Hero, held: Held, hole: Hole, heading: Heading, banner: Banner };`
		])
			expect(out).toContain(kept);
	});

	test('renamed region keys are honoured (importKeys)', () => {
		const out = registry_client_source(
			`import Hero from './Hero.svelte' with { hydrate: 'load' };\nexport { Hero };`,
			FILE,
			new Set(['hydrate', 'defer', 'preset', 'region'])
		)!;
		expect(out).toContain('const Hero = undefined;');
		expect(out).not.toContain('Hero.svelte');
	});

	test('asRegion: the call blanks, its component import drops, sibling names stay', () => {
		const src = [
			`import { Card, Plain } from './barrel';`,
			`export const Island = import.meta.og.asRegion(Card, { wake: 'load' });`,
			`export { Plain };`
		].join('\n');
		const out = registry_client_source(src, FILE, KEYS)!;
		expect(out).toContain(`import { Plain } from './barrel';`);
		expect(out).toContain('const Card = undefined;');
		expect(out).toContain('export const Island = undefined;');
	});

	test('asRegion on a sole default import drops the whole import', () => {
		const out = registry_client_source(
			`import Card from './Card.svelte';\nexport const C = import.meta.og.asRegion(Card, { wake: 'idle' });`,
			FILE,
			KEYS
		)!;
		expect(out).not.toContain('Card.svelte');
		expect(out).toContain('const Card = undefined;');
	});

	test('import.meta.og.regions(glob) blanks to an empty registry', () => {
		const out = registry_client_source(
			`export const blocks = import.meta.og.regions('./blocks/*.svelte');`,
			FILE,
			KEYS
		)!;
		expect(out).toBe(`export const blocks = ({});`);
	});

	test('a registry with no marks is returned unchanged; an unparsable one is null', () => {
		const plain = `import A from './A.svelte';\nexport { A };`;
		expect(registry_client_source(plain, FILE, KEYS)).toBe(plain);
		expect(registry_client_source('import {', FILE, KEYS)).toBeNull();
	});

	test('variant id round-trips the real path', () => {
		const id = registry_client_id(FILE);
		expect(id).toBe(FILE + REGISTRY_CLIENT_QUERY);
		expect(registry_client_path(id)).toBe(FILE);
		expect(registry_client_path(FILE)).toBeNull();
	});
});

describe('static_script_specs', () => {
	test('value imports, side-effect imports and re-exports; never type-only or dynamic', () => {
		const src = [
			`import A from './a';`,
			`import './side.css';`,
			`import type { T } from './types';`,
			`export { b } from './b';`,
			`export * from './c';`,
			`export type { U } from './utypes';`,
			`const lazy = () => import('./lazy');`
		].join('\n');
		expect(static_script_specs(src, '/app/x.ts')).toEqual(['./a', './side.css', './b', './c']);
	});
	test('unparsable → null', () => {
		expect(static_script_specs('export {', '/app/x.ts')).toBeNull();
	});
});
