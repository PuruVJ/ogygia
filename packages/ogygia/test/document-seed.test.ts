/**
 * `document()` (router-rendered pages) ships the SAME page seed the handle does, in the same
 * lanes: native JSON under `data-og-format="json"` for a JSON-exact slice, devalue otherwise.
 * Regression: the seed text must be the serialized text, never a stringified object.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'devalue';
import { document } from '../src/document.js';
import { region } from '../src/region.js';
import Tiny from './_fixtures/Tiny.svelte';

const SEED_RE = /<script type="application\/ogygia-page" data-ogygia-page([^>]*)>([^<]*)<\/script>/;

describe('document() page seed', () => {
	it('JSON lane: a plain pageState goes out as JSON and parses back', async () => {
		const res = await document(region(Tiny as never, { n: 1 } as never), {
			pageState: { url: { href: 'http://x/a?q=<b>' }, params: { id: '1' }, route: { id: '/a' }, status: 200, data: { site: 'ACME' } }
		});
		const html = await res.text();
		const m = SEED_RE.exec(html);
		expect(m, 'the seed script is in the head').not.toBeNull();
		expect(m![1]).toContain('data-og-format="json"');
		expect(m![2]).not.toContain('[object');
		expect(JSON.parse(m![2])).toMatchObject({ url: 'http://x/a?q=<b>', params: { id: '1' }, data: { site: 'ACME' } });
	});

	it('devalue lane: a Date in the data keeps devalue, no format attribute', async () => {
		const res = await document(region(Tiny as never, { n: 1 } as never), {
			pageState: { url: { href: 'http://x/a' }, params: {}, route: { id: '/a' }, status: 200, data: { at: new Date(9) } }
		});
		const m = SEED_RE.exec(await res.text())!;
		expect(m[1]).not.toContain('data-og-format');
		expect(parse(m[2])).toMatchObject({ data: { at: new Date(9) } });
	});
});
