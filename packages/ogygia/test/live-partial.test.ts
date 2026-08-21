// Live partials (Feature A): a dual partial is awaitable — awaiting it renders the component to
// HTML on the server and bakes it into the ticket, which the transport carries over the wire and the
// runtime swaps in with no fetch (morph for static, prop-push for interactive). Runs against `../dist`.
// DOM behaviour (morph / swap / keep-alive) is covered by the browser suite `verify/live-partial.ts`
// — this repo's unit tests stay node-only (no jsdom); DOM helpers are exercised in a real browser.

import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { region, isRegion } from '../dist/region.js';
import { ogygiaTransport } from '../dist/transport.js';
import { transformHost } from '../dist/compiler/region/transform.js';

/** A fake SSR partial-binding (what `virtual:ogygia/region/<iid>.js` exports on the server leg). */
function fakeBinding(overrides: Record<string, unknown> = {}) {
	const Comp = () => {};
	return {
		__ogRegion: 'abc123abc123',
		__module: '/_app/immutable/og-region.abc123abc123.js',
		__hydrate: 'load',
		__component: Comp,
		__sign: (id: string) => `SIG(${id})`,
		__renderHtml: (props: Record<string, unknown>) => `<p>${props.n ?? ''}</p>`,
		...overrides
	};
}

describe('region() — awaitable dual partial', () => {
	test('un-awaited dual carries no html and is not enumerable-thenable', () => {
		const f = region(fakeBinding() as never, { n: 5 } as never) as Record<string, unknown>;
		expect(isRegion(f)).toBe(true);
		expect(f.kind).toBe('dual');
		expect(f.html).toBeUndefined();
		// `then` exists (awaitable) but is NON-enumerable so spreads / devalue never copy it.
		expect(typeof (f as { then?: unknown }).then).toBe('function');
		expect(Object.keys(f)).not.toContain('then');
	});

	test('awaiting a dual renders its HTML and resolves to a non-thenable dual', async () => {
		const f = region(fakeBinding() as never, { n: 7 } as never);
		const resolved = (await f) as Record<string, unknown>;
		expect(resolved.kind).toBe('dual');
		expect(resolved.html).toBe('<p>7</p>');
		// Resolved value must NOT be thenable, or `await` would chain forever.
		expect((resolved as { then?: unknown }).then).toBeUndefined();
		expect(isRegion(resolved)).toBe(true);
	});

	test('a binding without __renderHtml (mis-wired) is not awaitable', () => {
		const f = region(fakeBinding({ __renderHtml: undefined }) as never, {} as never) as Record<
			string,
			unknown
		>;
		expect((f as { then?: unknown }).then).toBeUndefined();
	});
});

describe('transport — HTML rides the wire', () => {
	test('encode bakes html + signs url; decode rebuilds a deferred partial with html', async () => {
		const resolved = await region(fakeBinding() as never, { n: 9 } as never);
		const enc = ogygiaTransport.Region.encode(resolved);
		expect(enc).not.toBe(false);
		if (enc === false) return;
		expect(enc.u).toBe('SIG(abc123abc123)');
		expect(enc.x).toBe('<p>9</p>');
		expect(enc.h).toBe('load');

		const dec = ogygiaTransport.Region.decode(enc) as Record<string, unknown>;
		expect(dec.kind).toBe('deferred');
		expect(dec.html).toBe('<p>9</p>');
		expect(dec.url).toBe('SIG(abc123abc123)');
		expect(dec.hydrate).toBe('load');
	});

	test('an un-awaited dual encodes WITHOUT html (renders inline where it lands)', () => {
		const f = region(fakeBinding() as never, { n: 1 } as never);
		const enc = ogygiaTransport.Region.encode(f);
		expect(enc).not.toBe(false);
		if (enc === false) return;
		expect(enc.x).toBeUndefined();
	});

	test('a re-serialized deferred partial passes its html through', () => {
		const deferred = {
			[Symbol.for('ogygia.region')]: true,
			kind: 'deferred',
			id: 'x',
			props: {},
			url: '/u',
			module: '/m',
			html: '<b>hi</b>'
		};
		const enc = ogygiaTransport.Region.encode(deferred);
		expect(enc).not.toBe(false);
		if (enc === false) return;
		expect(enc.x).toBe('<b>hi</b>');
	});
});

describe('transform — SSR binding renders HTML, client leg stays metadata-only', () => {
	const src = `<script>
		import Card from '$lib/Card.svelte' with { region: 'raw' };
		import { region } from 'ogygia';
		export const f = region(Card, { id: 1 });
	</script>`;

	function ctx() {
		return {
			root: '/app',
			libDir: '/app/src/lib',
			readFile: () => null,
			pathModule: path,
			dev: false,
			virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
			wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
			devUrlFor: (p: string) => '/@id/' + p,
			visibleMargin: '0px',
			presets: {}
		};
	}

	test('SSR leg imports svelte/server render and exposes __renderHtml', () => {
		const r = transformHost(src, '/app/src/routes/+page.svelte', ctx());
		const isl = r!.islands[0] as Record<string, unknown>;
		const ssr = String(isl.bindingSsrSource);
		expect(ssr).toContain("from 'svelte/server'");
		expect(ssr).toContain('__renderHtml');
		// The client leg must NOT pull svelte/server or the component render in.
		expect(String(isl.bindingClientSource)).not.toContain('svelte/server');
		expect(String(isl.bindingClientSource)).not.toContain('__renderHtml');
	});
});
