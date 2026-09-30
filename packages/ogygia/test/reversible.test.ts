/**
 * REVERSIBLE TRANSFORMS, the server half (server/reversible.ts): ogygia marks the markup before an
 * app's transform, the transform renders its plan on the hosts ogygia will restore, and settle keeps
 * exactly what the browser's restorer needs — or strips everything, for a host without a plan.
 */
import { describe, expect, it } from 'vitest';
import { mark, settle, transformMarkup } from '../src/server/reversible.js';
import { fake_scoped } from './fixtures/fake-scoped-render.js';

const island = (inner: string) => `<ogygia-region entry="./a.js" data-og-fp="f1">${inner}</ogygia-region>`;
const doc = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
/** a csr=false document with one island */
const page = (inner: string) => doc(island(inner));

describe('mark', () => {
	it('plans the hosts in Svelte-owned markup and around it; tags every custom element’s children', () => {
		const html = doc(
			`<demo-card class="shell"><p>server</p></demo-card>` +
				`<demo-card id="lake-host"><ogygia-region wake="none">${island('<b>x</b>')}</ogygia-region></demo-card>` +
				island(`<demo-card class="own"><!--[--> Sign in <i>ok</i><!--]--></demo-card>`)
		);
		const m = mark(html, 'document', false)!;
		// a server-owned host with nothing Svelte-owned below: no plan
		expect(m.html).toContain('<demo-card og-u="0" class="shell"><p og-c="0.0">server</p>');
		// a server-owned host around an island: planned (adopting it would reach into the island)
		expect(m.html).toContain('<demo-card og-h="1" id="lake-host">');
		// in the island: planned, each child tagged — elements by attribute, text and comments by comment
		expect(m.html).toContain('<demo-card og-h="2" class="own"><!--og-c 2.0 c--><!--[--><!--og-c 2.1 t--> Sign in <i og-c="2.2">ok</i><!--og-c 2.3 c--><!--]-->');
		expect(m.record.hosts.get(2)!.children.get(1)!.text).toBe(' Sign in ');
	});

	it('a Kit-hydrated document is Svelte-owned throughout its body; a region answer plans every host', () => {
		expect(mark(doc('<demo-card><p>x</p></demo-card>'), 'document', true)!.html).toContain('og-h="0"');
		expect(mark('<demo-card><p>x</p></demo-card>', 'region', false)!.html).toContain('og-h="0"');
		expect(mark('<p>no custom elements</p>', 'region', false)).toBeNull();
	});

	it('marks text a trimmer could change, deeper inside a planned host’s children — never the first text of a <pre>', () => {
		const m = mark('<demo-card><p> a <b>b</b>c</p><pre>\n keep</pre></demo-card>', 'region', false)!;
		expect(m.html).toContain('<p og-c="0.0"><!--og-t 0.0--> a <b>b</b>c</p>');
		expect(m.html).toContain('<pre og-c="0.1">\n keep</pre>');
	});
});

describe('settle', () => {
	it('a planned host keeps what the restorer needs: the attributes to reset, the text the render changed', async () => {
		const html = page(`<demo-card class="own"><!--[-->   Sign in <i>ok</i>  <!--]--></demo-card>`);
		const s = await transformMarkup(html, fake_scoped, { kind: 'document' });
		expect(s.planned).toBe(1);
		// the host: Svelte's class back, the renderer's data-title kept (og-keep), the plan kept
		expect(s.html).toContain('og-shadow="demo-card.shadow"');
		expect(s.html).toContain(`og-r="${'{&quot;class&quot;:&quot;own&quot;}'}"`);
		// a child element: the renderer's c-id goes at the restore
		expect(s.html).toContain(`og-r="{&quot;c-id&quot;:null}"`);
		// the text children: "   Sign in " was trimmed to " Sign in " (kept with its original); the
		// whitespace-only "  " was dropped (kept with its original, to be put back)
		expect(s.html).toContain('<!--og-c 0.1 t "   Sign in "-->');
		expect(s.html).toContain('<!--og-c 0.3 t "  "-->');
	});

	it('a host without a plan loses every mark: left exactly as the transform wrote it', async () => {
		const html = doc('<demo-card class="shell"><p>server</p></demo-card><demo-skip><p> keep </p></demo-skip>');
		const s = await transformMarkup(html, fake_scoped, { kind: 'document' });
		expect(s.planned).toBe(0);
		// (the fake stamps its c-id on the children it saw tagged; everything of ogygia's is gone)
		expect(s.html).toBe(fake_scoped(html).split('<p>server').join('<p c-id="0.1">server'));
		// an og-h host the transform skipped (no og-shadow): untouched, marks gone
		const r = await transformMarkup('<demo-skip class="x"><p> keep </p></demo-skip>', (h) => h, { kind: 'region' });
		expect(r.html).toBe('<demo-skip class="x"><p> keep </p></demo-skip>');
	});

	it('stand-ins: a start tag the parser would restructure, where the render made either side of it', async () => {
		// the page's own link wraps a host whose tree is a link: the tree's <a> would close the page's
		const html = page('<a href="/card"><demo-link>Go</demo-link></a>');
		const s = await transformMarkup(html, fake_scoped, { kind: 'document' });
		expect(s.stand_ins).toBe(1);
		expect(s.html).toContain('<og-as class="link sc-demo-link" aria-hidden="true" tabindex="-1" href="#" tag="a">');
		expect(s.html).toContain('</slot></og-as></demo-link></a>');
		// the page's own misnesting (neither side made by the render) is left alone
		const own = await transformMarkup(doc('<a href="/1"><span><a href="/2">x</a></span></a><demo-card><p>y</p></demo-card>'), fake_scoped, { kind: 'document' });
		expect(own.stand_ins).toBe(0);
	});

	it('a block the tree opens inside a Svelte <p> becomes a stand-in too', async () => {
		const html = page('<p>Buy <demo-card>now</demo-card></p>');
		const s = await transformMarkup(html, fake_scoped, { kind: 'document' });
		expect(s.html).toContain('<og-as class="card sc-demo-card" tag="div">');
	});

	it('head assets in a document’s body go to its head, once per key', async () => {
		const sheet = '<template data-og-head="demo-card.shadow">b{color:red}</template>';
		const withSheets = (h: string) => h.split('<demo-card').join(`${sheet}<demo-card`);
		const html = page('<demo-card><p>a</p></demo-card><demo-card><p>b</p></demo-card>');
		const s = await transformMarkup(html, (h) => withSheets(fake_scoped(h)), { kind: 'document' });
		expect(s.head).toEqual([sheet]);
		expect(s.html).not.toContain('data-og-head');
	});

	it('dev: each planned host’s original children, for the browser’s check', async () => {
		const html = page('<demo-card class="own"> Sign in </demo-card>');
		const s = await transformMarkup(html, fake_scoped, { kind: 'document', dev: true });
		expect(s.check).toEqual({ 0: ' Sign in ' });
	});

	it('settle alone drops marks of hosts the transform never planned', () => {
		const m = mark('<demo-card><p> x </p></demo-card>', 'region', false)!;
		const s = settle(m.html, m.record);
		expect(s.html).toBe('<demo-card><p> x </p></demo-card>');
	});
});
