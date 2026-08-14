import { describe, expect, it } from 'vitest';
import { ogygiaTransport } from '../src/transport.js';
import { REGION_BRAND } from '../src/region.js';

const { encode, decode } = ogygiaTransport.Region;

const inline = (extra: Record<string, unknown> = {}) => ({
	[REGION_BRAND]: true,
	kind: 'inline' as const,
	component: () => {},
	props: { a: 1 },
	...extra
});

describe('transport — HTML-baked inline tickets', () => {
	it('an AWAITED inline region (html present) crosses as an HTML-only ticket', () => {
		const t = encode(inline({ html: '<p>hi</p>' }));
		expect(t).toEqual({ i: '', p: { a: 1 }, u: '', m: '', x: '<p>hi</p>' });
	});

	it('an un-awaited inline region still throws, and the error teaches `await`', () => {
		expect(() => encode(inline())).toThrow(/`await` the region/);
	});

	it('decode revives an HTML-only ticket as a deferred region carrying the html (no frame write)', () => {
		// node has no `document`, and the ticket has no url — both paths skip the frame store.
		const d = decode({ i: '', p: {}, u: '', m: '', x: '<p>hi</p>' }) as Record<string, unknown>;
		expect(d.kind).toBe('deferred');
		expect(d.html).toBe('<p>hi</p>');
		expect(d.url).toBe('');
	});

	it('non-regions are passed over (encode returns false)', () => {
		expect(encode({ html: 'nope' })).toBe(false);
		expect(encode(null)).toBe(false);
	});
});

describe('region() inline awaitability', () => {
	it('region(C, props) is thenable, and `then` is non-enumerable (devalue/spread never see it)', async () => {
		const { region } = await import('../src/region.js');
		const r = region((() => {}) as never, {} as never);
		expect(typeof (r as { then?: unknown }).then).toBe('function');
		expect(Object.keys(r)).not.toContain('then');
		// spreading drops the thenable — the settled copy must not re-arm `await`
		const copy = { ...r };
		expect((copy as { then?: unknown }).then).toBeUndefined();
	});
});
