/**
 * The flags plugin: its Vite value, its server half's two stages, and the facts its reads report.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PLUGIN_API, assignments } from 'ogygia/plugin';
import { set_personal_read_sink } from '../../ogygia/src/plugin/facts.js';
import { flags } from '../src/vite.js';
import server from '../src/server.js';
import { decide, flag } from '../src/index.js';

describe('flags()', () => {
	it('declares its server half, against the plugin API core speaks', () => {
		expect(flags()).toEqual({ name: 'flags', api: PLUGIN_API, server: '@ogygia/flags/server' });
	});
});

describe('the server half', () => {
	it('primes the source in `request` and drains exposures in `done`', async () => {
		const sent: unknown[][] = [];
		const gate = flag('plugin-test-gate');
		decide({ source: () => ({ 'plugin-test-gate': true }), exposure: (b) => void sent.push(b), batch: { max: 100, ms: 60_000 } });
		try {
			const request = new Request('http://x/');
			const url = new URL('http://x/');
			const event = { request, url, cookies: { get: () => undefined } } as never;
			await server.request!({ event, bag: undefined });
			expect(gate({ request, url })).toBe(true);
			server.done!({ event, bag: undefined });
			expect(sent.flat().some((e) => (e as { name: string }).name === 'plugin-test-gate')).toBe(true);
		} finally {
			decide({ source: undefined, exposure: undefined });
		}
	});
});

describe('facts a read reports', () => {
	afterEach(() => set_personal_read_sink(null));
	it('a read is a personal read (a cached page never stores one variant) and an assignment', () => {
		const seen: string[] = [];
		set_personal_read_sink((label) => seen.push(label));
		const hero = flag('plugin-test-hero', { a: 1, b: 1 });
		const request = new Request('http://x/');
		const variant = hero({ request, url: new URL('http://x/') });
		expect(seen).toEqual(['flag:plugin-test-hero']);
		expect(assignments(request)).toEqual({ 'plugin-test-hero': variant });
	});
});
