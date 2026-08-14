import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { content } from '../src/content/index.js';
import type { Heading, Source, SourceEntry } from '../src/content/index.js';
import { pharos as pharosRaw } from '../src/pharos/pharos.js';
import { dimensions, is_dimensioned } from '../src/pharos/dimensions.js';
import type { NavGroup, NavLeaf, NavTree } from '../src/pharos/types.js';

type Meta = { headings: Heading[] };

// Test shim: keep the positional call style; the real API is `pharos({ outline, …opts })`.
const pharos = (
	outlineArg: Parameters<typeof pharosRaw>[0]['outline'],
	opts: Partial<Parameters<typeof pharosRaw>[0]> = {}
) => pharosRaw({ outline: outlineArg, ...opts });

function fromArray(entries: SourceEntry<Meta>[]): Source<Meta> {
	const map = new Map(entries.map((e) => [e.id, e]));
	return {
		get: async (id) => map.get(id) ?? null,
		refs: async () => entries.slice()
	};
}

const schema = v.object({ title: v.string() });
const page = (id: string, fp: string, title: string): SourceEntry<Meta> => {
	const idDepth = id.split('/').filter(Boolean).length;
	const segs = fp.replace(/\/(\+doc|index)\.[^./]+$/, '').split('/').filter(Boolean).slice(-idDepth);
	const order = segs.map((s) => (s.match(/^(\d+)-/) ? Number(s.match(/^(\d+)-/)![1]) : Number.MAX_SAFE_INTEGER));
	return { id, filePath: fp, order, data: { title }, meta: { headings: [] } };
};

// en: a, b, c   |   fr: a, b (c UNtranslated)   |   v1: a only (old, never localized)
const en = () =>
	content({
		loader: fromArray([
			page('guide/a', 'docs/00-guide/00-a/+doc.svx', 'A en'),
			page('guide/b', 'docs/00-guide/01-b/+doc.svx', 'B en'),
			page('guide/c', 'docs/00-guide/02-c/+doc.svx', 'C en')
		]),
		schema
	});
const fr = () =>
	content({
		loader: fromArray([
			page('guide/a', 'docs/00-guide/00-a/+doc.svx', 'A fr'),
			page('guide/b', 'docs/00-guide/01-b/+doc.svx', 'B fr')
		]),
		schema
	});
const v1 = () => content({ loader: fromArray([page('guide/a', 'docs/00-guide/00-a/+doc.svx', 'A v1')]), schema });

const dim = () =>
	dimensions({
		axes: {
			version: { values: ['v1', 'v2'], default: 'v2', label: 'Version' },
			locale: { values: ['en', 'fr'], default: 'en', fallback: true, label: 'Language' }
		},
		weave: ({ version, locale }) => (version === 'v1' ? v1() : locale === 'fr' ? fr() : en())
	});

const site = () => pharos(dim(), { prevNext: 'order' });
const leafTitles = (tree: NavTree) =>
	tree
		.filter((n): n is NavGroup => n.kind === 'group')
		.flatMap((g) => g.items.filter((n): n is NavLeaf => n.kind === 'leaf').map((l) => l.title));

describe('dimensions — coordinate encoding', () => {
	it('default coordinate is bare; non-defaults get ordered segments', () => {
		const d = dim();
		expect(d.coordinateOf('guide/a')).toEqual({ version: 'v2', locale: 'en' });
		expect(d.coordinateOf('fr/guide/a')).toEqual({ version: 'v2', locale: 'fr' });
		expect(d.coordinateOf('v1/guide/a')).toEqual({ version: 'v1', locale: 'en' });
		expect(d.coordinateOf('v1/fr/guide/a')).toEqual({ version: 'v1', locale: 'fr' });
	});

	it('is_dimensioned narrows', () => {
		expect(is_dimensioned(dim())).toBe(true);
		expect(is_dimensioned({})).toBe(false);
	});
});

describe('dimensions — resolve serves the right coordinate', () => {
	it('picks content per coordinate', async () => {
		const s = site();
		expect((await s.doc('guide/a'))?.entry.data.title).toBe('A en');
		expect((await s.doc('fr/guide/a'))?.entry.data.title).toBe('A fr');
		expect((await s.doc('v1/guide/a'))?.entry.data.title).toBe('A v1');
	});

	it('re-prefixes the slug/href to the full address', async () => {
		const doc = await site().doc('fr/guide/b', { base: '/docs' });
		expect(doc?.slug).toBe('fr/guide/b');
		expect(doc?.href).toBe('/docs/fr/guide/b');
	});
});

describe('dimensions — fallback (render, never 404)', () => {
	it('untranslated page serves default-locale content with a fallback flag', async () => {
		const doc = await site().doc('fr/guide/c');
		expect(doc).not.toBeNull();
		expect(doc?.entry.data.title).toBe('C en'); // English content at the French URL
		expect(doc?.fallback).toEqual({ axis: 'locale', from: 'fr', to: 'en' });
	});

	it('native page has fallback null', async () => {
		expect((await site().doc('fr/guide/a'))?.fallback).toBeNull();
	});

	it('an axis without fallback 404s (version has no fallback)', async () => {
		expect(await site().doc('v1/guide/b')).toBeNull(); // v1 has no B, version does not fall back
	});

	it('doc carries the coordinate', async () => {
		expect((await site().doc('fr/guide/a'))?.coordinate).toEqual({ version: 'v2', locale: 'fr' });
	});
});

describe('dimensions — addresses union (prerender the whole matrix)', () => {
	it('includes fallback URLs and excludes non-fallback misses', async () => {
		const addrs = new Set(await dim().addresses());
		// default (v2/en)
		expect(addrs.has('guide/a')).toBe(true);
		expect(addrs.has('guide/c')).toBe(true);
		// fr: a,b native + c via fallback
		expect(addrs.has('fr/guide/a')).toBe(true);
		expect(addrs.has('fr/guide/c')).toBe(true);
		// v1: only a (no fallback for version → no v1/guide/b)
		expect(addrs.has('v1/guide/a')).toBe(true);
		expect(addrs.has('v1/guide/b')).toBe(false);
	});
});

describe('dimensions — nav reflects the coordinate', () => {
	it('nav(slug) shows that coordinate’s tree', async () => {
		const s = site();
		expect(leafTitles(await s.nav({ slug: 'guide/a' }))).toEqual(['A en', 'B en', 'C en']);
		expect(leafTitles(await s.nav({ slug: 'fr/guide/a' }))).toEqual(['A fr', 'B fr']);
		expect(leafTitles(await s.nav({ slug: 'v1/guide/a' }))).toEqual(['A v1']);
	});

	it('nav hrefs carry the coordinate prefix', async () => {
		const tree = await site().nav({ slug: 'fr/guide/a', base: '/docs' });
		const first = tree.filter((n): n is NavGroup => n.kind === 'group')[0].items[0] as NavLeaf;
		expect(first.href).toBe('/docs/fr/guide/a');
	});
});

describe('dimensions — switcher never dead-ends', () => {
	it('offers every axis value with a resolvable href', async () => {
		const sw = await site().switcher('fr/guide/a', { base: '/docs' });
		expect(sw).not.toBeNull();
		const locale = sw!.find((a) => a.axis === 'locale')!;
		expect(locale.current).toBe('fr');
		expect(locale.options.map((o) => o.value)).toEqual(['en', 'fr']);
		const en_opt = locale.options.find((o) => o.value === 'en')!;
		expect(en_opt.href).toBe('/docs/guide/a'); // English of the same page (bare, default)
		expect(en_opt.missing).toBe(false);
	});

	it('a value where the page is missing points at that coordinate root, flagged missing', async () => {
		// v1 has no page 'guide/c'; switching version on the C page must not dead-link.
		const sw = await site().switcher('guide/c');
		const version = sw!.find((a) => a.axis === 'version')!;
		const v1_opt = version.options.find((o) => o.value === 'v1')!;
		expect(v1_opt.missing).toBe(true);
		expect(v1_opt.href).toBe('/v1/guide/a'); // v1's HOME page, never a dead coordinate root
	});

	it('plain (non-dimensioned) site returns null switcher', async () => {
		const plain = pharos(en());
		expect(await plain.switcher('guide/a')).toBeNull();
	});
});

describe('dimensions — neighbors are coordinate-prefixed', () => {
	it('next stays in the same coordinate', async () => {
		const doc = await site().doc('fr/guide/a');
		expect(doc?.trail.next?.slug).toBe('fr/guide/b');
		expect(doc?.trail.next?.title).toBe('B fr');
	});
});

describe('dimensions — pharos load/entries integration (the real mount)', () => {
	it('load resolves a valid coordinate slug and 404s an unknown one', async () => {
		const s = site();
		await expect(
			s.load({ params: { slug: 'fr/guide/a' }, url: new URL('http://x/fr/guide/a') })
		).resolves.toBeUndefined();
		// fr/guide/c falls back to en → also resolves (render, not 404)
		await expect(
			s.load({ params: { slug: 'fr/guide/c' }, url: new URL('http://x/fr/guide/c') })
		).resolves.toBeUndefined();
		// v1/guide/b has no page and version does not fall back → 404
		await expect(
			s.load({ params: { slug: 'v1/guide/b' }, url: new URL('http://x/v1/guide/b') })
		).rejects.toBeTruthy();
	});

	it('entries prerenders the coordinate-prefixed union (incl. fallback URLs)', async () => {
		const slugs = new Set((await site().entries()).map((e) => e.slug));
		expect(slugs.has('guide/a')).toBe(true); // default coord, bare
		expect(slugs.has('fr/guide/a')).toBe(true);
		expect(slugs.has('fr/guide/c')).toBe(true); // fallback page still prerenders
		expect(slugs.has('v1/guide/a')).toBe(true);
		expect(slugs.has('v1/guide/b')).toBe(false); // no page, no fallback
	});
});
