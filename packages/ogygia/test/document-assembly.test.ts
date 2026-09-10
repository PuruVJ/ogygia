/**
 * DOCUMENT ASSEMBLY (server/document-assembly.ts) — the handle locates `</head>` and `</body>` once
 * and assembles its injections from slices, never with whole-document `replace` passes. These tests
 * pin the contract (placement, streamed chunks without an injection point, a page carrying `</body>`
 * inside a script string) AND the budget: on a multi-MB document the transform must touch the string
 * a bounded number of times, and never copy the body.
 */
import { describe, expect, it } from 'vitest';
import { assemble, locate } from '../src/server/document-assembly.js';
import { html_has_kit_bootstrap } from '../src/runtime/kit-boot.js';

const doc = (body: string, head = '<title>t</title>') =>
	`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('locate', () => {
	it('finds both injection points', () => {
		const html = doc('<p>x</p>');
		const s = locate(html);
		expect(html.slice(s.head_end, s.head_end + 7)).toBe('</head>');
		expect(html.slice(s.body_end, s.body_end + 7)).toBe('</body>');
	});

	it('reports -1 for a chunk without the point (streamed head / body chunks)', () => {
		expect(locate('<html><head><title>t</title></head><body><p>')).toEqual({ head_end: 28, body_end: -1 });
		expect(locate('<p>more</p></body></html>')).toEqual({ head_end: -1, body_end: 11 });
		expect(locate('<p>middle</p>')).toEqual({ head_end: -1, body_end: -1 });
	});

	it('takes the LAST </body> — a script string mentioning it does not fool the tail', () => {
		const html = doc('<script>var s = "</body>";</script><p>after</p>');
		const s = locate(html);
		expect(html.slice(s.body_end)).toBe('</body></html>');
	});
});

describe('assemble', () => {
	it('places the head injection before </head> and the body injection before </body>', () => {
		const html = doc('<p>x</p>');
		const out = assemble(html, locate(html), null, '<meta name="h">', '<script>b</script>');
		expect(out).toBe(
			'<!doctype html><html><head><title>t</title><meta name="h"></head><body><p>x</p><script>b</script></body></html>'
		);
	});

	it('returns the very same string when there is nothing to inject', () => {
		const html = doc('<p>x</p>');
		expect(assemble(html, locate(html), null, '', '')).toBe(html);
	});

	it('swaps in a rewritten head slice (the deduped head) without touching the body', () => {
		const html = doc('<p>body</p>', '<link rel="stylesheet" href="/a"><link rel="stylesheet" href="/a">');
		const spans = locate(html);
		const head = '<!doctype html><html><head><link rel="stylesheet" href="/a">';
		expect(assemble(html, spans, head, '', '')).toBe(head + '</head><body><p>body</p></body></html>');
	});

	it('drops the body injection on a chunk with no </body> (streamed head chunk)', () => {
		const chunk = '<html><head><title>t</title></head><body><p>';
		expect(assemble(chunk, locate(chunk), null, '<meta name="h">', '<script>never</script>')).toBe(
			'<html><head><title>t</title><meta name="h"></head><body><p>'
		);
	});

	it('drops the head injection on a chunk with no </head> (streamed tail chunk)', () => {
		const chunk = '<p>tail</p></body></html>';
		expect(assemble(chunk, locate(chunk), null, '<meta name="never">', '<script>b</script>')).toBe(
			'<p>tail</p><script>b</script></body></html>'
		);
	});

	it('never runs String.replace on the document (an og.$ factory source with `$$` survives)', () => {
		const html = doc('<p>x</p>');
		const inject = '<script>globalThis.__OG_FNM={"t":(()=>`$$ ${1}`)}</script>';
		expect(assemble(html, locate(html), null, '', inject)).toContain(inject);
	});
});

describe('budget on a multi-MB document', () => {
	// A 2.6 MB body: locating + assembling must be a handful of bounded string operations, and the
	// only allocations are the small injected strings (V8 keeps slices and concatenations as views
	// and ropes — nothing here forces a flatten).
	const big = doc('<div>' + 'x'.repeat(2_600_000) + '</div>');

	it('locate touches the string with exactly two bounded scans', () => {
		const calls: string[] = [];
		const index_of = String.prototype.indexOf;
		const last_index_of = String.prototype.lastIndexOf;
		String.prototype.indexOf = function (this: string, ...args: [string, number?]) {
			if (this.length > 1_000_000) calls.push('indexOf');
			return index_of.apply(this, args);
		} as typeof String.prototype.indexOf;
		String.prototype.lastIndexOf = function (this: string, ...args: [string, number?]) {
			if (this.length > 1_000_000) calls.push('lastIndexOf');
			return last_index_of.apply(this, args);
		} as typeof String.prototype.lastIndexOf;
		try {
			locate(big);
		} finally {
			String.prototype.indexOf = index_of;
			String.prototype.lastIndexOf = last_index_of;
		}
		expect(calls).toEqual(['indexOf', 'lastIndexOf']);
	});

	it('assemble never calls replace/split/match on the big string', () => {
		const banned = ['replace', 'replaceAll', 'split', 'match', 'matchAll'] as const;
		const originals = Object.fromEntries(banned.map((k) => [k, String.prototype[k]]));
		const hits: string[] = [];
		for (const k of banned) {
			(String.prototype as unknown as Record<string, unknown>)[k] = function (this: string, ...args: unknown[]) {
				if (this.length > 1_000_000) hits.push(k);
				return (originals[k] as (...a: unknown[]) => unknown).apply(this, args);
			};
		}
		try {
			const out = assemble(big, locate(big), null, '<meta name="h">', '<script>b</script>');
			expect(out.length).toBe(big.length + '<meta name="h">'.length + '<script>b</script>'.length);
		} finally {
			for (const k of banned) (String.prototype as unknown as Record<string, unknown>)[k] = originals[k];
		}
		expect(hits).toEqual([]);
	});

	it('the csr probe reads only the last 64 KB before </body>, not the document', () => {
		// Kit's boot sits at the end of the body — a bootstrap 3 MB up the page is not Kit's.
		const early = doc('<script>var __sveltekit_x = 1;</script>' + '<i>' + 'y'.repeat(3_000_000) + '</i>');
		expect(html_has_kit_bootstrap(early, locate(early).body_end)).toBe(false);
		const late = doc('<i>' + 'y'.repeat(3_000_000) + '</i><script>var __sveltekit_x = 1;</script>');
		expect(html_has_kit_bootstrap(late, locate(late).body_end)).toBe(true);
		// …and a side-channel payload inside the window still never counts (P0).
		const reflected = doc(
			'<i>' + 'y'.repeat(3_000_000) + '</i><script type="application/ogygia-page">{"u":"?q=__sveltekit_x="}</script>'
		);
		expect(html_has_kit_bootstrap(reflected, locate(reflected).body_end)).toBe(false);
	});
});
