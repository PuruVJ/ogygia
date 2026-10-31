// og.source() — core's data sources: the macro rewrite (strict position law) and the runtime
// wrapper (fingerprint, id stamp, receipt tag). What a plugin does with the receipts (freeze's
// reverse index) is tested in that plugin.
import { describe, it, expect, afterEach } from 'vitest';
import { rewrite_source } from '../src/compiler/macros/source.ts';
import {
	__og_source,
	fingerprint_args,
	source_tag,
	source_tag_of,
	set_source_recorder,
	set_source_observer,
	SOURCE_ID
} from '../src/source.ts';

const MARKUP: readonly string[] = ['.svelte'];

// ── the macro ──────────────────────────────────────────────────────────────────────────────────

describe('macros/source — strict position law', () => {
	it('rewrites the legal shape, stamping file#export and injecting the runtime import', () => {
		const src = `export const loadDoc = import.meta.og.source(async (slug) => slug);\n`;
		const out = rewrite_source(src, '/app/src/lib/server/cms.ts', 'src/lib/server/cms.ts', MARKUP);
		expect(out).toContain(`import { __og_source } from 'ogygia/internal';`);
		expect(out).toContain(
			`export const loadDoc = __og_source("src/lib/server/cms.ts#loadDoc", async (slug) => slug)`
		);
	});

	it('keeps the optional { key } argument verbatim', () => {
		const src = `export const f = import.meta.og.source((a) => a, { key: (a) => String(a) });\n`;
		const out = rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP);
		expect(out).toContain(`__og_source("x.ts#f", (a) => a, { key: (a) => String(a) })`);
	});

	it('is a no-op without the marker (same reference)', () => {
		const src = `export const f = () => 1;\n`;
		expect(rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toBe(src);
	});

	it('never rewrites the marker inside a string', () => {
		const src = `export const s = "export const f = import.meta.og.source(fn)";\n`;
		expect(rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toBe(src);
	});

	it('errors on a non-exported declaration', () => {
		const src = `const f = import.meta.og.source((a) => a);\n`;
		expect(() => rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toThrow(/export const/);
	});

	it('errors on bare access and on nested calls', () => {
		expect(() =>
			rewrite_source(`const x = [import.meta.og.source];\n`, '/app/x.ts', 'x.ts', MARKUP)
		).toThrow(/bare/);
		expect(() =>
			rewrite_source(
				`export const f = () => import.meta.og.source((a) => a);\n`,
				'/app/x.ts',
				'x.ts',
				MARKUP
			)
		).toThrow(/outside/);
	});

	it('errors on let / destructuring / wrong arity', () => {
		expect(() =>
			rewrite_source(
				`export let f = import.meta.og.source((a) => a);\n`,
				'/app/x.ts',
				'x.ts',
				MARKUP
			)
		).toThrow(/const/);
		expect(() =>
			rewrite_source(`export const f = import.meta.og.source();\n`, '/app/x.ts', 'x.ts', MARKUP)
		).toThrow(/args/);
	});
});

// ── the runtime ────────────────────────────────────────────────────────────────────────────────

describe('source runtime', () => {
	afterEach(() => {
		set_source_recorder(null);
		set_source_observer(null);
	});

	it('fingerprints are stable, order-insensitive on object keys, event-shape aware', () => {
		expect(fingerprint_args(['promo'])).toBe(fingerprint_args(['promo']));
		expect(fingerprint_args([{ a: 1, b: 2 }])).toBe(fingerprint_args([{ b: 2, a: 1 }]));
		expect(fingerprint_args(['promo'])).not.toBe(fingerprint_args(['other']));
		const event_ish = {
			url: new URL('http://x/fr/fr/home'),
			request: {} as never,
			route: { id: '/[lang]/[region]/home' }
		};
		// the same route+path fingerprints identically regardless of the rest of the event
		expect(fingerprint_args([event_ish])).toBe(
			fingerprint_args([{ ...event_ish, cookies: {} as never }])
		);
	});

	it('wraps: passes through, stamps the id, records the receipt tag', () => {
		const seen: string[] = [];
		set_source_recorder((tag) => seen.push(tag));
		const fn = __og_source('lib/cms.ts#read', (slug: string) => `doc:${slug}`);
		expect(fn('promo')).toBe('doc:promo');
		expect((fn as never as Record<symbol, string>)[SOURCE_ID]).toBe('lib/cms.ts#read');
		expect(seen).toEqual([source_tag('lib/cms.ts#read', fingerprint_args(['promo']))]);
	});

	it('honors the { key } canonicalizer', () => {
		const seen: string[] = [];
		set_source_recorder((tag) => seen.push(tag));
		const fn = __og_source('x#f', (a: { id: number }) => a.id, { key: (a) => String(a.id) });
		fn({ id: 7 });
		expect(seen).toEqual(['s:x#f:7']);
	});

	it('the observer sees every receipt too; a throwing seam never fails the call', () => {
		const observed: string[] = [];
		set_source_recorder(() => {
			throw new Error('recorder down');
		});
		set_source_observer((tag) => observed.push(tag));
		const fn = __og_source('x#g', (n: number) => n * 2);
		expect(fn(2)).toBe(4);
		expect(observed).toEqual([source_tag('x#g', fingerprint_args([2]))]);
	});

	it('source_tag_of reads the stamp back (the key canonicalizer included); null when unstamped', () => {
		const plain = __og_source('x#h', (slug: string) => slug);
		expect(source_tag_of(plain, ['a'])).toBe(source_tag('x#h', fingerprint_args(['a'])));
		const keyed = __og_source('x#k', (a: { id: number }) => a.id, { key: (a) => String(a.id) });
		expect(source_tag_of(keyed as never, [{ id: 9 }])).toBe('s:x#k:9');
		expect(source_tag_of((() => 0) as never)).toBeNull();
	});
});
