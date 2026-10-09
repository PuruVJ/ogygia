/**
 * keepFallback() from a server island rendered INLINE (nested inside a `wake` island, where the
 * deferred mark is ignored) used to throw its signal into Kit's page render — a 500 for the whole
 * page, with a message that pointed nowhere ("the page fallback stands"). It now fails with the
 * reason. On the endpoint (the hole rendered as its own root) the signal is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import Region from '../src/Region.svelte';
import KeepHole from './_fixtures/KeepHole.svelte';
import HostWithHole from './_fixtures/HostWithHole.svelte';
import { is_keep_fallback, KEEP_FALLBACK_INLINE_MESSAGE } from '../src/keep-fallback.js';

const region = Region as unknown as Component<Record<string, unknown>>;
// `render()`'s body is a LAZY getter — the component runs on first read.
const body_of = (c: Component<Record<string, unknown>>, props: Record<string, unknown>) =>
	render(c, { props }).body;

describe('keepFallback() placement', () => {
	it('on the endpoint (the hole is the render root): the branded signal, as before', () => {
		let caught: unknown;
		try {
			void body_of(KeepHole as never, {});
		} catch (e) {
			caught = e;
		}
		expect(is_keep_fallback(caught)).toBe(true);
	});

	it('as a top-level server island in the page pass: the fallback renders, the component never runs', () => {
		const html = body_of(region, {
			__mode: 'server',
			__entry: 'hole-keep',
			__component: KeepHole,
			__props: {},
			__defer: 'load'
		});
		expect(html).toContain('render="defer"');
		expect(html).not.toContain('never rendered');
	});

	it('NESTED inside an island (rendered inline): a real error that names the cause, not the signal', () => {
		let caught: unknown;
		try {
			void body_of(region, {
				__mode: 'island',
				__entry: '/islands/host.js',
				__component: HostWithHole,
				__props: {},
				load: true
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(is_keep_fallback(caught)).toBe(false);
		expect((caught as Error).message).toBe(KEEP_FALLBACK_INLINE_MESSAGE);
		expect((caught as Error).message).toContain('nested inside a `wake` island');
	});
});
