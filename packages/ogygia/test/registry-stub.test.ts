// link/registry-stub.ts — the names-only stub a csr=false route host imports instead of a region
// registry on the client leg of a build (Kit would otherwise link every registry component's CSS).
import { describe, expect, test } from 'vitest';
import {
	export_names,
	imported_names,
	is_registry_stub_id,
	registry_stub_id,
	registry_stub_names,
	registry_stub_source
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
