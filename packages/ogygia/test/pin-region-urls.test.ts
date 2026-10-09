// A region's `entry` / `src` / `endpoint` are written relative to the page that rendered it (Kit's
// default `paths.relative`). Read again after a client navigation, they resolved against the NEW
// address: an island imported `/a/b/_app/…` (a redirect to an HTML page), and a hole's key changed
// with the page's depth. Pinned once, at the address that wrote them, they read the same everywhere.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pin_region_urls } from '../src/runtime/entry-locations.js';

const g = globalThis as Record<string, unknown>;
let had_location: unknown;
beforeEach(() => {
	had_location = g.location;
	g.location = { href: 'https://site.test/ww/en/insights/', origin: 'https://site.test' };
});
afterEach(() => {
	g.location = had_location;
});

/** A region element as far as the pin reads it. */
function region(attrs: Record<string, string>) {
	const a = new Map(Object.entries(attrs));
	return {
		getAttribute: (n: string) => a.get(n) ?? null,
		setAttribute: (n: string, v: string) => void a.set(n, v),
		attrs: a
	} as unknown as Element & { attrs: Map<string, string> };
}

describe('pin_region_urls', () => {
	it('entry, src and endpoint, against the address the element entered at → root-absolute', () => {
		const el = region({
			entry: '../../_app/immutable/og-region.6ad105b9b102.js',
			src: '../../_app/immutable/og-region.6ad105b9b102.Ab12.js',
			endpoint: '../../__ogygia__?id=9cec&props=e30&exp=1&sig=s'
		});
		pin_region_urls(el);
		expect(el.attrs.get('entry')).toBe('/ww/_app/immutable/og-region.6ad105b9b102.js');
		expect(el.attrs.get('src')).toBe('/ww/_app/immutable/og-region.6ad105b9b102.Ab12.js');
		expect(el.attrs.get('endpoint')).toBe('/ww/__ogygia__?id=9cec&props=e30&exp=1&sig=s');
	});

	it('a fetched page, against its own URL: the same strings as the page that wrote them shallower', () => {
		const shallow = region({ endpoint: './__ogygia__?id=9cec&props=e30' });
		const deep = region({ endpoint: '../../../__ogygia__?id=9cec&props=e30' });
		pin_region_urls(shallow, 'https://site.test/');
		pin_region_urls(deep, 'https://site.test/fr/fr/work/');
		expect(deep.attrs.get('endpoint')).toBe(shallow.attrs.get('endpoint'));
		expect(deep.attrs.get('endpoint')).toBe('/__ogygia__?id=9cec&props=e30');
	});

	it('leaves alone what is pinned already, another origin, and what holds no URL', () => {
		const el = region({ entry: '/_app/immutable/x.js', src: 'https://cdn.other.test/x.js', endpoint: '' });
		pin_region_urls(el);
		expect(el.attrs.get('entry')).toBe('/_app/immutable/x.js');
		expect(el.attrs.get('src')).toBe('https://cdn.other.test/x.js');
		expect(el.attrs.get('endpoint')).toBe('');
		// a relative value that lands on another origin (an assets CDN base): as written
		const cross = region({ src: '../x.js' });
		pin_region_urls(cross, 'https://cdn.other.test/a/b/');
		expect(cross.attrs.get('src')).toBe('../x.js');
	});
});
