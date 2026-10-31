// ONE ISLANDS ENDPOINT (server/endpoint.ts): `handle({ endpoint })` moves the handler AND every URL
// minted for it. REGRESSION (field report, 0.8.0): the option moved only the handler — pages still
// minted `/__ogygia__?…`, the handler answered only on the new path, and every hole 404'd (behind a
// proxy forwarding only the app's own prefixes, and without one).
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('virtual:ogygia/secret', () => ({ buildKey: 'test-secret', buildHadSecret: false }));
vi.mock('virtual:ogygia/session-cookie', () => ({ sessionCookie: null }));
vi.mock('virtual:ogygia/region-ttl', () => ({ regionTtl: 3600, renewWindow: 691200 }));
vi.mock('virtual:ogygia/server-manifest', () => ({
	island_url: {},
	island_render: { rnd123: 'c0ffee0c0ffe' }
}));
vi.mock('virtual:ogygia/sign', () => ({
	sign: (_k: string, m: string) => 'sig' + m.length,
	region_mac_message: (...parts: unknown[]) => parts.join('|')
}));

const { configure_islands_endpoint, islands_endpoint, DEFAULT_ISLANDS_ENDPOINT } =
	await import('../src/server/endpoint.ts');
const { mintServerIsland, makeRegionEndpoint } = await import('../src/server/region-endpoint.ts');
const { renders_for_a_page } = await import('../src/server/render-page.ts');
const { mpaSpeculationRules } = await import('../src/compiler/link/speculation.ts');

afterEach(() => configure_islands_endpoint(undefined));

const at = (path: string) => ({ url: new URL('https://a.test' + path) }) as never;

describe('the islands endpoint', () => {
	it('defaults to /__ogygia__, for the handler and the mint alike', () => {
		expect(islands_endpoint()).toBe(DEFAULT_ISLANDS_ENDPOINT);
		expect(mintServerIsland('abc123', {})).toMatch(/^\/__ogygia__\?id=abc123&/);
	});

	it('handle({ endpoint }) moves every minted URL with the handler', () => {
		configure_islands_endpoint('/_server/api/__ogygia__');
		expect(mintServerIsland('abc123', { a: 1 })).toMatch(
			/^\/_server\/api\/__ogygia__\?id=abc123&props=/
		);
		expect(makeRegionEndpoint('abc123', {})).toMatch(/^\/_server\/api\/__ogygia__\?id=abc123&/);
		// a render on the new path is a hole render (it renders for a page); the old path is a page now
		expect(renders_for_a_page(at('/_server/api/__ogygia__'))).toBe(true);
		expect(renders_for_a_page(at('/__ogygia__'))).toBe(false);
		// (under the app's base: matched by suffix, as the handler matches it)
		expect(renders_for_a_page(at('/sub/_server/api/__ogygia__'))).toBe(true);
	});

	it('a minted capability names its signing key (`&k=`, outside the MAC)', () => {
		expect(mintServerIsland('abc123', {})).toMatch(/&sig=[^&]+&k=[^&]+$/);
	});

	it('a minted capability names what it renders (`&r=`, its render identity, signed)', () => {
		const url = mintServerIsland('rnd123', {});
		expect(url).toMatch(/\?id=rnd123&r=c0ffee0c0ffe&props=/);
		// (the mocked sign hashes the message by length: the render identity is part of it)
		const sig = new URL(url, 'http://x').searchParams.get('sig');
		expect(sig).toBe(
			'sig' +
				[
					'rnd123',
					new URL(url, 'http://x').searchParams.get('exp'),
					'W3t9XQ',
					'',
					'',
					'c0ffee0c0ffe'
				].join('|').length
		);
	});

	it('a region with no render identity mints as before (no `r`)', () => {
		expect(mintServerIsland('def456', {})).not.toContain('&r=');
	});

	it('a path without its leading slash gets one', () => {
		configure_islands_endpoint('api/__ogygia__');
		expect(islands_endpoint()).toBe('/api/__ogygia__');
		expect(renders_for_a_page(at('/myapi/__ogygia__'))).toBe(false);
	});

	it('MPA speculation rules leave out the endpoint the handle serves', () => {
		expect(mpaSpeculationRules('/_server/api/__ogygia__')).toContain(
			'"href_matches":"/_server/api/__ogygia__*"'
		);
		expect(mpaSpeculationRules()).toContain('"href_matches":"/__ogygia__*"');
	});
});
