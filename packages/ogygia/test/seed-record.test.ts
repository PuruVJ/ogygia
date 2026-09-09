/**
 * SEED ONLY WHEN READ — Region.svelte always records the page snapshot (the handle needs it for the
 * freeze verdict and server-side page reads) but ASKS for the client seed (`seed: true`) only for a
 * region whose client code reads `$page` (`islandReadsPage(entry)`, the build's chunk-closure
 * answer; fail-open when unknown). A page whose islands take everything as props asks for nothing,
 * so the handle ships no `application/ogygia-page` seed at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import { set_page_recorder } from '../src/page-seed-registry.js';
import { set_reads_page } from './_stubs/virtual-island-deps.js';
import { region as make_region } from '../src/region.js';

// `render()`'s body is a LAZY getter — the component runs on first read, so every render here reads it.

const region = Region as unknown as Component<Record<string, unknown>>;

let records: Array<{ snap: unknown; seed: boolean }>;
beforeEach(() => {
	records = [];
	set_page_recorder((snap, seed) => records.push({ snap, seed }));
});
afterEach(() => {
	set_page_recorder(null);
	set_reads_page(true);
});

const island = (extra: Record<string, unknown> = {}) => ({
	__mode: 'island',
	__entry: '/islands/tiny.js',
	__component: Tiny,
	__props: { n: 1 },
	load: true,
	...extra
});
const hole = (extra: Record<string, unknown> = {}) => ({
	__mode: 'server',
	__entry: 'hole-1',
	__component: Tiny,
	__props: {},
	__defer: 'load',
	...extra
});
const seeds = () => records.map((r) => r.seed);

describe('page snapshot recording', () => {
	it('an island whose closure reads $page → snapshot recorded AND the seed asked for', () => {
		set_reads_page(true);
		void render(region, { props: island() }).body;
		expect(seeds()).toEqual([true]);
		expect(records[0].snap).toMatchObject({ status: 200 });
		expect(records[0].snap).toHaveProperty('data');
	});

	it('an island whose closure never reads $page → snapshot still recorded, seed NOT asked for', () => {
		set_reads_page(false);
		void render(region, { props: island() }).body;
		expect(seeds()).toEqual([false]);
		expect(records[0].snap).toHaveProperty('data'); // the freeze verdict still sees the load data
	});

	it('the same rule for visible / interaction islands (the wake does not matter)', () => {
		set_reads_page(false);
		void render(region, { props: island({ load: undefined, visible: true }) }).body;
		void render(region, { props: island({ load: undefined, interaction: true }) }).body;
		expect(seeds()).toEqual([false, false]);
		set_reads_page(true);
		void render(region, { props: island({ load: undefined, visible: true }) }).body;
		expect(seeds()).toEqual([false, false, true]);
	});

	it('a server island that hydrates follows its client module; a static hole never asks', () => {
		set_reads_page(true);
		void render(region, { props: hole() }).body; // static hole: no client, no reader
		void render(region, { props: hole({ __hydrate: 'load', __module: '/islands/hole.js' }) }).body;
		set_reads_page(false);
		void render(region, { props: hole({ __hydrate: 'load', __module: '/islands/hole.js' }) }).body;
		expect(seeds()).toEqual([false, true, false]);
	});

	it('a lake and a plain inline held region never ask (no client at all)', () => {
		set_reads_page(true);
		void render(region, { props: { __mode: 'lake', __entry: '/lake.js' } }).body;
		void render(region, { props: { of: make_region(Tiny as never, {}) } }).body;
		expect(seeds().some(Boolean)).toBe(false);
	});

	it('a promise `of` (module unknown until it resolves) asks — fail-open', () => {
		set_reads_page(false);
		void render(region, { props: { of: new Promise(() => {}), placeholder: undefined } }).body;
		expect(seeds()).toEqual([true]);
	});
});
