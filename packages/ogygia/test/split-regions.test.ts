// `scanRegions()` — the supported splitter for an app that runs a third-party SSR/hydration pass
// over the final HTML and must never reshape island bytes. The whole point is that it CANNOT be
// fooled by tag-like text the way a regex balance-count is (a `<ogygia-region>` in a CSS comment
// threw a customer's count off, so their island skip silently stopped applying in dev).
import { describe, it, expect } from 'vitest';
import { scanRegions, type RegionSpan } from '../src/server/split-regions.js';

const kinds = (html: string) => [...scanRegions(html)].map((r) => r.kind);
const one = (html: string): RegionSpan => {
	const all = [...scanRegions(html)];
	expect(all).toHaveLength(1);
	return all[0];
};

describe('classification', () => {
	it('reads island / lake / hole off the attributes', () => {
		expect(one('<ogygia-region entry="/e.js" wake="visible"></ogygia-region>').kind).toBe('island');
		expect(one('<ogygia-region entry="/e.js" wake="none"></ogygia-region>').kind).toBe('lake');
		expect(
			one('<ogygia-region render="defer" when="load" endpoint="/__ogygia__?id=x"></ogygia-region>')
				.kind
		).toBe('hole');
	});

	it('a hole is a hole even with a wake attribute (endpoint wins)', () => {
		expect(
			one('<ogygia-region wake="interaction" endpoint="/__ogygia__?id=x"></ogygia-region>').kind
		).toBe('hole');
	});
});

describe('spans', () => {
	it('start / innerStart / innerEnd / end bracket the element and its inner HTML', () => {
		const html = `<div><ogygia-region entry="/e.js" wake="load"><p>hi</p></ogygia-region></div>`;
		const r = one(html);
		expect(html.slice(r.start, r.end)).toBe(
			'<ogygia-region entry="/e.js" wake="load"><p>hi</p></ogygia-region>'
		);
		expect(html.slice(r.innerStart, r.innerEnd)).toBe('<p>hi</p>');
		expect(r.attrs.entry).toBe('/e.js');
		expect(r.attrs.wake).toBe('load');
	});
});

describe('cannot be fooled by tag-like text', () => {
	it('ignores <ogygia-region> inside a CSS comment in an inlined <style> (the reported bug)', () => {
		const html =
			`<style>/* the mega-menu hole wraps items in one <ogygia-region> element */ .a{color:red}</style>` +
			`<ogygia-region entry="/e.js" wake="visible"><b>real</b></ogygia-region>`;
		const all = [...scanRegions(html)];
		expect(all).toHaveLength(1);
		expect(html.slice(all[0].innerStart, all[0].innerEnd)).toBe('<b>real</b>');
	});

	it('ignores <ogygia-region> and stray </ogygia-region> inside an HTML comment', () => {
		const html =
			`<!-- authoring note: <ogygia-region> … </ogygia-region> is emitted per island -->` +
			`<ogygia-region entry="/e.js" wake="load">x</ogygia-region>`;
		expect(kinds(html)).toEqual(['island']);
	});

	it('ignores tag-like text inside a <script> body', () => {
		const html =
			`<script>const s = "</ogygia-region>"; // never a real close\n</script>` +
			`<ogygia-region wake="none">lake</ogygia-region>`;
		expect(kinds(html)).toEqual(['lake']);
	});

	it('a `>` inside an attribute value does not end the tag early', () => {
		const html = `<ogygia-region entry="/e.js" wake="load" data-x="a>b"><i>ok</i></ogygia-region>`;
		const r = one(html);
		expect(r.attrs['data-x']).toBe('a>b');
		expect(html.slice(r.innerStart, r.innerEnd)).toBe('<i>ok</i>');
	});
});

describe('nesting', () => {
	it('yields a login island nested inside a header lake so the caller can protect it', () => {
		const html =
			`<ogygia-region wake="none">` + // header lake
			`  <nav>menu</nav>` +
			`  <ogygia-region entry="/login.js" wake="interaction"><button>login</button></ogygia-region>` +
			`</ogygia-region>`;
		const all = [...scanRegions(html)];
		// post-order: the nested island closes first, then the lake
		expect(all.map((r) => r.kind)).toEqual(['island', 'lake']);
		const island = all.find((r) => r.kind === 'island')!;
		expect(island.depth).toBe(1);
		expect(html.slice(island.start, island.end)).toContain('<button>login</button>');
	});

	it('does NOT yield regions strictly inside an island (its subtree is atomic)', () => {
		const html =
			`<ogygia-region entry="/host.js" wake="load">` +
			`  <ogygia-region wake="none">a lake inside an island — not the caller's to touch</ogygia-region>` +
			`</ogygia-region>`;
		// only the island itself
		expect(kinds(html)).toEqual(['island']);
	});

	it('yields a hole inside a lake (recurse into lakes and holes)', () => {
		const html =
			`<ogygia-region wake="none">` +
			`<ogygia-region render="defer" when="load" endpoint="/__ogygia__?id=x">fallback</ogygia-region>` +
			`</ogygia-region>`;
		expect(kinds(html)).toEqual(['hole', 'lake']);
	});
});

describe('robustness', () => {
	it('a self-closing region yields without opening a subtree', () => {
		expect(kinds('<ogygia-region wake="load" />after')).toEqual(['island']);
	});

	it('an unterminated region is surfaced, not swallowed', () => {
		const r = one('<ogygia-region wake="load">oops no close');
		expect(r.kind).toBe('island');
		expect(r.start).toBe(0);
	});

	it('a document with no regions yields nothing', () => {
		expect([...scanRegions('<div><p>plain</p></div>')]).toEqual([]);
	});

	it('does not match <ogygia-region-ish> (a longer tag name)', () => {
		expect([...scanRegions('<ogygia-region-thing></ogygia-region-thing>')]).toEqual([]);
	});
});
