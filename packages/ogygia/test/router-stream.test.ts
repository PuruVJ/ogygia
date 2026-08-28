/**
 * Streamed pages — `page(async function* ...)`: the flushed part carries the first yield + the
 * inline boot; every later yield is an inert template chunk on the SAME response; the generator
 * throwing after the flush becomes an error-card chunk (never a broken page); non-GET renders
 * buffer to the FINAL yield. mount({ stream }) is the sugar: fallback → doc | offline card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { routes, page, mount } from '../src/router/index.js';

afterEach(() => vi.unstubAllGlobals());

const doc_json = (body = 'B') => JSON.stringify({ status: 200, title: 't', css: [], body });

describe('page(async function*) — the streamed slot', () => {
	const app = routes({
		'/s': page(async function* () {
			yield '<p data-first>skeleton</p>';
			yield '<p data-late>payload</p>';
		})
	});

	it('flushes the first yield, chunks the rest as templates, boots once', async () => {
		const res = await app.fetch(new Request('http://x/s', { headers: { accept: 'text/html' } }));
		expect(res!.headers.get('content-length')).toBeNull(); // streams have no length
		const html = await res!.text();
		const i_first = html.indexOf('data-first');
		const i_boot = html.indexOf('data-og-late-boot');
		const i_tpl = html.indexOf('<template data-og-late="pg">');
		const i_late = html.indexOf('data-late');
		expect(i_first).toBeGreaterThan(-1);
		expect(html).toContain('og-late-slot');
		expect(i_boot).toBeGreaterThan(-1);
		expect(i_boot).toBeLessThan(i_first); // boot lives in the head, before the body
		expect(i_tpl).toBeGreaterThan(i_first); // late chunk AFTER the flushed part
		expect(i_late).toBeGreaterThan(i_tpl); // …inside the template
		expect(html.trimEnd().endsWith('</html>')).toBe(true); // tail held back until the end
	});

	it('a throw AFTER the flush becomes an error-card chunk, page still closes', async () => {
		const boom = routes({
			'/s': page(async function* () {
				yield '<p data-first>ok</p>';
				throw new Error('upstream <died>');
			})
		});
		const html = await (await boom.fetch(new Request('http://x/s')))!.text();
		expect(html).toContain('data-og-late-error');
		expect(html).toContain('upstream &lt;died&gt;'); // escaped into the card
		expect(html.trimEnd().endsWith('</html>')).toBe(true);
	});

	it('yields REAL regions — async generators auto-await them, the resolved shapes must bake', async () => {
		// the exact gap that let e2e fail while string-only tests stayed green
		const { og_html_region, region } = await import('../src/region.js');
		const { default: RawHtml } = await import('../src/RawHtml.svelte');
		const app2 = routes({
			'/s': page(async function* () {
				yield og_html_region('<p data-first>inline region</p>'); // resolves via its own bake
				yield region(RawHtml as never, { html: '<p data-late>component region</p>' });
			})
		});
		const html = await (await app2.fetch(new Request('http://x/s')))!.text();
		expect(html).toContain('data-first');
		const tpl = html.slice(html.indexOf('<template data-og-late'));
		expect(tpl).toContain('data-late'); // the component region BAKED into the chunk
		expect(html).not.toContain('data-og-late-error');
	});

	it('a region that cannot bake fails LOUDLY into the error card (never an empty chunk)', async () => {
		const app2 = routes({
			'/s': page(async function* () {
				yield '<p data-first>ok</p>';
				// a "region" that resolved without html — the unmarked-import shape
				yield { kind: 'dual', props: {} };
			})
		});
		const html = await (await app2.fetch(new Request('http://x/s')))!.text();
		expect(html).toContain('data-og-late-error');
		expect(html).toContain('did not bake');
	});

	it('non-GET buffers to the FINAL yield (actions need a whole answer)', async () => {
		const acted = routes({
			'/s': page(
				async function* () {
					yield '<p data-first>skeleton</p>';
					yield '<p data-late>payload</p>';
				},
				{ actions: { default: () => ({ ok: true }) } }
			)
		});
		const res = await acted.fetch(new Request('http://x/s', { method: 'POST', body: '' }));
		const html = await res!.text();
		expect(html).toContain('data-late'); // the final state, rendered in place
		expect(html).not.toContain('<template data-og-late'); // no chunks on a buffered render
	});
});

describe('mount({ stream: true }) — the sugar', () => {
	it('fallback flushes; the doc (css+head+body) rides the late chunk', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(
					JSON.stringify({
						status: 200,
						title: 't',
						css: ['<link rel="stylesheet" href="http://mfe.test/x.css">'],
						head: '<meta name="description" content="d">',
						body: '<p data-mfe>hi</p>'
					})
				)
		);
		const app = routes({ '/cms/[...rest]': mount('http://mfe.test', { stream: true }) });
		const html = await (await app.fetch(new Request('http://shell/cms/p')))!.text();
		const i_fb = html.indexOf('data-og-mount-fallback');
		const i_tpl = html.indexOf('<template data-og-late');
		expect(i_fb).toBeGreaterThan(-1);
		expect(i_tpl).toBeGreaterThan(i_fb);
		const chunk = html.slice(i_tpl);
		expect(chunk).toContain('data-mfe');
		expect(chunk).toContain('x.css'); // fragment css travels in the chunk (hoisted on swap)
		expect(chunk).toContain('name="description"');
	});

	it('a dead MFE yields the offline card AFTER the flush — first byte never waited', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		const app = routes({
			'/cms/[...rest]': mount('http://mfe.test', { stream: true, timeout: 50 })
		});
		const html = await (await app.fetch(new Request('http://shell/cms/p')))!.text();
		expect(html).toContain('data-og-mount-fallback');
		expect(html).toContain('data-og-mount-failed');
	});

	it('a late redirect degrades to a link card (status already flushed)', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(
					JSON.stringify({ status: 303, location: '/cms/posts/1', title: '', css: [], body: '' })
				)
		);
		const app = routes({ '/cms/[...rest]': mount('http://mfe.test', { stream: true }) });
		const html = await (await app.fetch(new Request('http://shell/cms/old')))!.text();
		expect(html).toContain('data-og-mount-moved');
		expect(html).toContain('href="/cms/posts/1"');
	});
});
