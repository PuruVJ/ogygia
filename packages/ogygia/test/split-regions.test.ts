// `scanRegions()` — the supported splitter for an app that runs a third-party SSR/hydration pass
// over the final HTML and must never reshape island bytes. The whole point is that it CANNOT be
// fooled by tag-like text the way a regex balance-count is (a `<ogygia-region>` in a CSS comment
// threw a customer's count off, so their island skip silently stopped applying in dev).
import { describe, it, expect } from 'vitest';
import {
	scanRegions,
	liftRegions,
	restoreRegions,
	type RegionSpan
} from '../src/server/split-regions.js';

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

describe('tag names are case-insensitive, and whole names only', () => {
	it('an upper-case region is a region; an upper-case raw-text element is skipped', () => {
		expect(one('<OGYGIA-REGION entry="/e.js" wake="load"><p>x</p></Ogygia-Region>').kind).toBe('island');
		expect(kinds('<SCRIPT>"<ogygia-region wake=load>"</SCRIPT><Style>/*<ogygia-region>*/</STYLE>')).toEqual([]);
	});

	it('a longer name that starts with a known one is not that tag', () => {
		expect(kinds('<ogygia-regionx wake="load"></ogygia-regionx>')).toEqual([]);
		expect(kinds('<scripts><ogygia-region entry="/e.js" wake="load"></ogygia-region></scripts>')).toEqual(['island']);
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

	it('ignores <ogygia-region> inside ANOTHER element’s attribute value (double-quoted)', () => {
		const html = `<div data-note="<ogygia-region>">x</div><ogygia-region wake="load">real</ogygia-region>`;
		const r = one(html);
		expect(r.kind).toBe('island');
		expect(html.slice(r.start, r.end)).toBe('<ogygia-region wake="load">real</ogygia-region>');
	});

	it('ignores a stray </ogygia-region> inside a single-quoted attribute value', () => {
		const html = `<a title='</ogygia-region>'><ogygia-region wake="none">L</ogygia-region>`;
		expect(kinds(html)).toEqual(['lake']);
	});

	it('a region’s OWN tag can carry a `<ogygia-region>` in an attribute without spawning a phantom', () => {
		const html = `<ogygia-region wake="load" data-x="<ogygia-region>"><b>ok</b></ogygia-region>`;
		const r = one(html);
		expect(r.attrs['data-x']).toBe('<ogygia-region>');
		expect(html.slice(r.innerStart, r.innerEnd)).toBe('<b>ok</b>');
	});

	it('a stray `<` in text (a < b) is not a tag', () => {
		expect(kinds('a < b <ogygia-region wake="load">real</ogygia-region>')).toEqual(['island']);
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

	it('an unterminated region is surfaced (span is just its opening tag)', () => {
		const html = '<ogygia-region id="a">';
		const r = one(html);
		expect(r.kind).toBe('island');
		expect(r.start).toBe(0);
		// documented: no close → innerStart === innerEnd, end at the `>` of the opening tag
		expect(r.innerStart).toBe(r.innerEnd);
		expect(r.end).toBe(html.length);
		expect(html.slice(r.innerStart, r.innerEnd)).toBe('');
	});

	it('a document with no regions yields nothing', () => {
		expect([...scanRegions('<div><p>plain</p></div>')]).toEqual([]);
	});

	it('does not match <ogygia-region-ish> (a longer tag name)', () => {
		expect([...scanRegions('<ogygia-region-thing></ogygia-region-thing>')]).toEqual([]);
	});
});

describe('liftRegions / restoreRegions — the round-trip for a third-party SSR pass', () => {
	it('lifts top-level regions to element placeholders and restores byte-for-byte', () => {
		const html = 'a<ogygia-region entry="/e.js" wake="load">x</ogygia-region>b';
		const { shell, regions } = liftRegions(html);
		expect(shell).toBe('a<og-lift data-i="0"></og-lift>b');
		expect(regions).toHaveLength(1);
		expect(regions[0].kind).toBe('island');
		expect(regions[0].outerHtml).toBe('<ogygia-region entry="/e.js" wake="load">x</ogygia-region>');
		expect(restoreRegions(shell, regions)).toBe(html);
	});

	it('transplants the renderer marks stamped on a placeholder onto the region opening tag', () => {
		const html = '<ogygia-region entry="/e.js" wake="visible">inner</ogygia-region>';
		const { shell, regions } = liftRegions(html);
		// The scoped renderer annotates the placeholder (a ::slotted rule -> sc- class + c-id/s-sn).
		const rendered = shell.replace(
			'<og-lift data-i="0"></og-lift>',
			'<og-lift data-i="0" class="sc-x-nav" c-id="0.5795" s-sn=""></og-lift>'
		);
		const out = restoreRegions(rendered, regions);
		expect(out).toContain('entry="/e.js"');
		expect(out).toContain('class="sc-x-nav"');
		expect(out).toContain('c-id="0.5795"');
		expect(out).toContain('s-sn=""');
		expect(out).toContain('>inner</ogygia-region>');
		expect(out).not.toContain('og-lift');
	});

	it('unions the renderer class with a class the region already carries', () => {
		const html = '<ogygia-region class="mine" wake="none">x</ogygia-region>';
		const { regions } = liftRegions(html);
		const out = restoreRegions('<og-lift data-i="0" class="sc-x"></og-lift>', regions);
		expect(out).toContain('class="mine sc-x"');
	});

	it('never clobbers an attribute the region already owns', () => {
		const html = '<ogygia-region entry="/real.js" wake="load">x</ogygia-region>';
		const { regions } = liftRegions(html);
		const out = restoreRegions('<og-lift data-i="0" entry="/spoof.js" c-id="0.1"></og-lift>', regions);
		expect(out).toContain('entry="/real.js"');
		expect(out).not.toContain('/spoof.js');
		expect(out).toContain('c-id="0.1"');
	});

	it('withInner reshapes a lake/hole inner while preserving the tags and index', () => {
		const html = '<ogygia-region wake="none"><p>old</p></ogygia-region>';
		const { regions } = liftRegions(html);
		const reshaped = regions[0].withInner('<p>new</p>');
		expect(reshaped.kind).toBe('lake');
		expect(reshaped.index).toBe(0);
		expect(reshaped.outerHtml).toBe('<ogygia-region wake="none"><p>new</p></ogygia-region>');
		expect(restoreRegions('<og-lift data-i="0"></og-lift>', [reshaped])).toBe(reshaped.outerHtml);
	});

	it('keeps a nested region inside its parent outerHtml (only top level is lifted)', () => {
		const html =
			'<ogygia-region wake="none"><ogygia-region entry="/e.js" wake="load">i</ogygia-region></ogygia-region>';
		const { shell, regions } = liftRegions(html);
		expect(shell).toBe('<og-lift data-i="0"></og-lift>');
		expect(regions).toHaveLength(1);
		expect(regions[0].kind).toBe('lake');
		expect(regions[0].innerHtml).toContain('<ogygia-region entry="/e.js"');
	});

	it('leaves an unknown placeholder in place rather than dropping it', () => {
		const { regions } = liftRegions('<ogygia-region wake="load">x</ogygia-region>');
		expect(restoreRegions('<og-lift data-i="9"></og-lift>', regions)).toBe(
			'<og-lift data-i="9"></og-lift>'
		);
	});

	it('the element placeholder survives a renderer that drops leading comments', () => {
		const html = '<!--[--><ogygia-region entry="/e.js" wake="load">x</ogygia-region>';
		const { shell, regions } = liftRegions(html);
		// parse5 discards a leading comment run; the element placeholder is not a comment, so it stays.
		const rendered = shell.replace('<!--[-->', '');
		expect(restoreRegions(rendered, regions)).toBe(
			'<ogygia-region entry="/e.js" wake="load">x</ogygia-region>'
		);
	});

	it('restores even when the renderer emits the placeholder without a closing tag', () => {
		const { regions } = liftRegions('<ogygia-region wake="load">x</ogygia-region>');
		expect(restoreRegions('<og-lift data-i="0">', regions)).toBe(
			'<ogygia-region wake="load">x</ogygia-region>'
		);
	});

	it('returns the html untouched when there are no regions', () => {
		const html = '<div><p>plain</p></div>';
		const { shell, regions } = liftRegions(html);
		expect(shell).toBe(html);
		expect(regions).toEqual([]);
		expect(restoreRegions(html, regions)).toBe(html);
	});
});
