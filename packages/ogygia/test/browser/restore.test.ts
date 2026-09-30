// THE RESTORER (runtime/restore.ts), in a real browser: markup a scoped server render reshaped
// (test/fixtures/fake-scoped-render.ts) comes back in the form hydration and the component runtime
// expect — each planned host a shadow root holding its rendered tree, Svelte's children back in its
// light DOM exactly as Svelte rendered them, the host's attributes back to Svelte's — in the document,
// in an answer's inert fragment (sheets adopted after the insertion), and never into a root a
// component's constructor made.
import { afterEach, expect, test } from 'vitest';
import { check_script, transformMarkup } from '../../src/server/reversible.js';
import { restore, restore_adopt } from '../../src/runtime/restore.js';
import { fake_scoped } from '../fixtures/fake-scoped-render.js';

const SHEET = '<template data-og-head="demo-card.shadow">b{color:rgb(255, 0, 0)}</template>';
const island = (inner: string) => `<ogygia-region entry="./a.js" data-og-fp="f1">${inner}</ogygia-region>`;
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

/** the settled page's body, parsed into this document (the head sheet too), and the original */
async function served(inner: string) {
	const s = await transformMarkup(doc(island(inner)), fake_scoped, { kind: 'document', dev: true });
	const body = s.html.slice(s.html.indexOf('<body>') + 6, s.html.lastIndexOf('</body>'));
	document.head.insertAdjacentHTML('beforeend', SHEET);
	document.body.innerHTML = body;
	return s;
}
/** the browser's own serialization of an HTML string (to compare against a live DOM's) */
const serialized = (html: string) => {
	const t = document.createElement('template');
	t.innerHTML = html;
	return t.innerHTML;
};

afterEach(() => {
	document.body.innerHTML = '';
	for (const t of Array.from(document.head.querySelectorAll('[data-og-head]'))) t.remove();
	(window as { __og_sheets?: unknown }).__og_sheets = undefined;
});

test('the document: a shadow root with the tree, Svelte’s children back exactly, the host’s attributes back', async () => {
	const inner = '<!--[-->   Sign in <i title="x">ok</i>  <!--]-->';
	const s = await served(`<demo-card class="own">${inner}</demo-card>`);
	expect(s.planned).toBe(1);
	expect(restore(document)).toBe(1);
	const host = document.querySelector('demo-card')!;
	// light DOM: exactly Svelte's (the trimmed text and the dropped whitespace node put back)
	expect(host.innerHTML).toBe(serialized(inner));
	// the tree in the shadow root, its slot a real slot, the keyed sheet adopted
	expect(host.shadowRoot!.querySelector('b')!.textContent).toBe('Card title');
	expect(host.shadowRoot!.querySelector('slot')!.assignedNodes().length).toBeGreaterThan(0);
	expect(host.shadowRoot!.adoptedStyleSheets.length).toBe(1);
	expect(getComputedStyle(host.shadowRoot!.querySelector('b')!).color).toBe('rgb(255, 0, 0)');
	// the host: Svelte's class, the renderer's og-keep attribute, no ogygia marks
	expect(host.getAttribute('class')).toBe('own');
	expect(host.getAttribute('data-title')).toBe('Card');
	expect([...host.attributes].map((a) => a.name).filter((n) => n.startsWith('og-'))).toEqual([]);
	expect(document.body.innerHTML.includes('og-c')).toBe(false);
});

test('a stand-in keeps the parser from splitting the page’s link, and becomes a real <a> in the tree', async () => {
	await served('<a href="/card"><demo-link>Go</demo-link></a>');
	// as parsed: the page's link still holds the host (the tree's link is a stand-in)
	expect(document.querySelector('a[href="/card"] demo-link')).not.toBeNull();
	restore(document);
	expect(document.querySelector('og-as')).toBeNull();
	expect(document.querySelector('a[href="/card"] demo-link')).not.toBeNull();
});

test('an answer’s fragment: restored before insertion, its sheets adopted once the host is in the page', async () => {
	const s = await transformMarkup('<demo-card class="x"> hi </demo-card>', (h) => SHEET + fake_scoped(h), { kind: 'region' });
	const tpl = document.createElement('template');
	tpl.innerHTML = s.html;
	restore(tpl.content);
	const host = tpl.content.querySelector('demo-card')!;
	expect(host.shadowRoot).not.toBeNull();
	expect(host.innerHTML).toBe(' hi ');
	// the sheet moved to the head (once), adopted after the insertion
	expect(document.head.querySelectorAll('[data-og-head="demo-card.shadow"]').length).toBe(1);
	document.body.appendChild(tpl.content);
	restore_adopt();
	expect(document.querySelector('demo-card')!.shadowRoot!.adoptedStyleSheets.length).toBe(1);
});

test('a host upgraded before the restore reached it is left as served, and says so', async () => {
	await served('<demo-card class="own"> late </demo-card>');
	const host = document.querySelector('demo-card')!;
	host.attachShadow({ mode: 'open' }); // what a component constructor does on upgrade
	let late = '';
	document.addEventListener('ogygia:restore-late', (e) => (late = (e as CustomEvent).detail.host), { once: true });
	expect(restore(document)).toBe(0);
	expect(late).toBe('0');
	expect(host.shadowRoot!.childNodes.length).toBe(0);
});

test('dev: the check compares each restored host with Svelte’s children, and names the first difference', async () => {
	const inner = ' Sign in <i>ok</i>';
	// a transform that loses a child ogygia can't know about (it strips the tag along with the node)
	const lossy = (h: string) => fake_scoped(h).split(/<i c-id="0\.1" og-c="0\.1">ok<\/i>/).join('');
	const s = await transformMarkup(doc(island(`<demo-card class="own">${inner}</demo-card>`)), lossy, { kind: 'document', dev: true });
	const body = s.html.slice(s.html.indexOf('<body>') + 6, s.html.lastIndexOf('</body>'));
	document.head.insertAdjacentHTML('beforeend', SHEET);
	document.body.innerHTML = check_script(s.check!) + body;
	let diff = '';
	document.addEventListener('ogygia:restore-mismatch', (e) => (diff = (e as CustomEvent).detail.diff), { once: true });
	const quiet = console.error;
	console.error = () => {};
	try {
		restore(document);
	} finally {
		console.error = quiet;
	}
	expect(diff).toContain('Svelte has <i>, the restored markup has nothing');
	// (and the script is consumed)
	expect(document.querySelector('script[type="application/ogygia-restore-check"]')).toBeNull();
});

test('text a render trimmed inside a custom element it did not render comes back through the planned host above', async () => {
	const inner = '<rich-text><p>a</p>\n\t\t<p>b</p></rich-text>';
	await served(`<demo-card class="own">${inner}</demo-card>`);
	restore(document);
	// (the fake stamps its c-id on every tagged element it saw; the whitespace between is the point)
	expect((document.querySelector('rich-text')!.childNodes[1] as Text).data).toBe('\n\t\t');
});

test('the dev check reads class as tokens and style as declarations, an empty one as absent', async () => {
	const inner = '<p style="" class="">x</p><p style="--cols: 4">y</p>';
	// a serializer that normalizes class and style on every element it writes
	const normalizing = (h: string) => fake_scoped(h).split(' style=""').join('').split(' class=""').join('').split('--cols: 4"').join('--cols: 4;"');
	const s = await transformMarkup(doc(island(`<demo-card class="own">${inner}</demo-card>`)), normalizing, { kind: 'document', dev: true });
	const body = s.html.slice(s.html.indexOf('<body>') + 6, s.html.lastIndexOf('</body>'));
	document.head.insertAdjacentHTML('beforeend', SHEET);
	document.body.innerHTML = check_script(s.check!) + body;
	let diff = '';
	document.addEventListener('ogygia:restore-mismatch', (e) => (diff = (e as CustomEvent).detail.diff), { once: true });
	restore(document);
	expect(diff).toBe('');
});

test('a DOM without adoptable sheets or CSS.escape (jsdom): a <style> per root', async () => {
	await served('<demo-card class="own"> x </demo-card>');
	const desc = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets')!;
	const escape = CSS.escape;
	Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', { configurable: true, get: () => undefined, set: () => {} });
	(CSS as { escape?: unknown }).escape = undefined;
	try {
		expect(restore(document)).toBe(1);
	} finally {
		Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', desc);
		CSS.escape = escape;
	}
	const root = document.querySelector('demo-card')!.shadowRoot!;
	expect(root.querySelector('style')!.textContent).toContain('b{color');
});

test('a planned host inside a declarative shadow root the page shipped is restored too', async () => {
	const s = await transformMarkup(doc(island('<div class="wrap"><template shadowrootmode="open"><demo-card class="own"> deep </demo-card></template></div>')), fake_scoped, { kind: 'document' });
	const body = s.html.slice(s.html.indexOf('<body>') + 6, s.html.lastIndexOf('</body>'));
	document.head.insertAdjacentHTML('beforeend', SHEET);
	document.body.setHTMLUnsafe(body);
	expect(restore(document)).toBe(1);
	const card = document.querySelector('.wrap')!.shadowRoot!.querySelector('demo-card')!;
	expect(card.shadowRoot!.querySelector('b')!.textContent).toBe('Card title');
	expect(card.innerHTML).toBe(' deep ');
});

test('self-contained: the function source runs on its own (the handle inlines it)', async () => {
	await served('<demo-card class="own"> inline </demo-card>');
	const standalone = new Function(`return (${restore.toString()})`)() as typeof restore;
	expect(standalone(document)).toBe(1);
	expect(document.querySelector('demo-card')!.innerHTML).toBe(' inline ');
});
