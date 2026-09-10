/**
 * The page seed's LANE (server/page-seed.ts): a JSON-exact slice goes out as native JSON (escaped
 * once for the `<script>`), anything else as devalue (already `<`-safe). Both round-trip.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'devalue';
import { PageSeed } from '../src/server/page-seed.js';

const page = (data: unknown, error: unknown = null) => ({
	url: { href: 'http://x/?q=<a>' },
	params: { id: '1' },
	route: { id: '/[id]' },
	status: 200,
	data,
	form: null,
	error
});

describe('PageSeed.serialize', () => {
	it('JSON lane: native text, `<` escaped, JSON.parse gives the slice back', () => {
		const out = PageSeed.serialize(page({ list: [1, 2, { s: '</script>' }] }), undefined, true)!;
		expect(out.json).toBe(true);
		expect(out.text).not.toContain('<');
		expect(JSON.parse(out.text)).toEqual({
			url: 'http://x/?q=<a>',
			params: { id: '1' },
			route: { id: '/[id]' },
			status: 200,
			data: { list: [1, 2, { s: '</script>' }] },
			form: null,
			error: null
		});
	});

	it('devalue lane (the default): devalue text, no second escape, parse gives the slice back', () => {
		const out = PageSeed.serialize(page({ when: new Date(7), s: '<i>' }))!;
		expect(out.json).toBe(false);
		expect(out.text).not.toContain('<');
		expect(parse(out.text)).toMatchObject({ data: { when: new Date(7), s: '<i>' } });
	});

	it('asked for JSON on a slice JSON cannot carry (a bigint): falls back to devalue, never throws', () => {
		const out = PageSeed.serialize(page({ n: 10n }), undefined, true)!;
		expect(out.json).toBe(false);
		expect(parse(out.text)).toMatchObject({ data: { n: 10n } });
	});

	it('one non-serializable field is dropped, never the whole seed (devalue lane)', () => {
		const out = PageSeed.serialize(page({ ok: 1 }, { fn: () => 1 }))!;
		expect(out.json).toBe(false);
		const v = parse(out.text) as { data: unknown; error?: unknown };
		expect(v.data).toEqual({ ok: 1 });
		expect(v.error).toBeUndefined();
	});
});
