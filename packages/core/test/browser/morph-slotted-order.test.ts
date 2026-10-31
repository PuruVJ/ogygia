// WHO ORDERS A CUSTOM ELEMENT'S CHILDREN (ownership.ts `order_owner`), in a real browser. One with a
// SHADOW ROOT shows its light DOM through `<slot>`s in document order: the render's order is the only
// order. A field mega menu (its tabs custom elements slotted by a custom-element menu) kept a tab the
// CMS moved last in its old place, and a tab the hole's answer added (hidden in the page's fallback
// behind an `{#if}`) landed among the wrong siblings, its panel shuffled with it — the morph matched
// in place and never moved, as for an element that relocates its own children. One with NO shadow
// root renders its light DOM itself and may relocate it: its arrangement stands (an identical answer
// moves nothing), as before.
import { afterEach, expect, test } from 'vitest';
import { morph_children } from '../../src/runtime/morph.ts';

class SlottingMenu extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: 'open' }).innerHTML = '<nav><slot></slot></nav>';
	}
}
class SlottingItem extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
	}
}
// renders its light DOM itself: moves its element children after everything else, as it connects
class RelocatingShell extends HTMLElement {
	connectedCallback() {
		for (const child of Array.from(this.children)) this.append(child);
	}
}
customElements.define('so-menu', SlottingMenu);
customElements.define('so-item', SlottingItem);
customElements.define('so-shell', RelocatingShell);

afterEach(() => {
	document.body.innerHTML = '';
});

const parse = (html: string) => {
	const t = document.createElement('template');
	t.innerHTML = html;
	return [...t.content.childNodes];
};
const item = (n: number) => `<so-item id="i${n}"></so-item>`;
const panel = (n: number) => `<div data-c="c${n}"></div>`;
const label = (n: Node) =>
	n.nodeType === 8
		? `<!--${(n as Comment).data}-->`
		: n.nodeType === 3
			? null
			: (n as Element).id || (n as Element).getAttribute('data-c');
const all = (host: Element) => [...host.childNodes].map(label).filter(Boolean);
const elements = (host: Element) => [...host.children].map(label);
const shape = (html: string, pick: (h: Element) => unknown) =>
	pick(Object.assign(document.createElement('div'), { innerHTML: html }));

// Svelte's shape: `{#each}` tabs, each an `{#if}` tab + an `{#if}` panel, block markers around them
const tab = (n: number, show: boolean, with_panel: boolean) =>
	'<!--[-->' +
	(show ? `<!--[-->${item(n)}<!--]-->` : '<!--[!--><!--]-->') +
	(with_panel ? `<!--[-->${panel(n)}<!--]-->` : '<!--[!--><!--]-->') +
	'<!--]-->';
const menu = (ids: number[], shown: (n: number) => boolean, panels: boolean) =>
	'<!--[-->' + ids.map((n) => tab(n, shown(n), panels)).join('') + '<!--]-->';

function mount(tag: string, html: string) {
	const host = document.createElement(tag);
	document.body.append(host);
	host.innerHTML = html;
	return host;
}

test('a slotting element: the answer adds a tab the fallback hid — every node lands in the answer’s order', () => {
	const fallback = menu([1, 2, 3, 4, 5, 6], (n) => n !== 6, false);
	const answer = menu([1, 2, 3, 4, 5, 6], () => true, true);
	const host = mount('so-menu', fallback);
	const kept = host.querySelector('#i2');
	morph_children(host, parse(answer));
	expect(elements(host)).toEqual(shape(answer, elements));
	expect(all(host)).toEqual(shape(answer, all));
	expect(host.querySelector('#i2'), 'a tab both sides render is kept, not re-created').toBe(kept);
});

test('a slotting element: the CMS moved a tab — the answer’s order applies, every tab kept', async () => {
	const host = mount('so-menu', [1, 2, 3, 4, 5, 6].map(item).join(''));
	const before = [...host.children];
	morph_children(host, parse([3, 1, 2, 4, 5, 6].map(item).join('')));
	expect(elements(host)).toEqual(['i3', 'i1', 'i2', 'i4', 'i5', 'i6']);
	expect(before.every((n) => n.parentNode === host)).toBe(true);
});

test('a slotting element keeps a child it gave itself while the render’s nodes take the answer’s order', () => {
	const host = mount('so-menu', [1, 2, 3].map(item).join(''));
	const own = document.createElement('span');
	own.setAttribute('data-c', 'own');
	host.insertBefore(own, host.children[1]);
	morph_children(host, parse([3, 1, 2].map(item).join('')));
	expect(own.parentNode, 'the element’s own child stays').toBe(host);
	expect(elements(host).filter((x) => x !== 'own')).toEqual(['i3', 'i1', 'i2']);
});

test('a slotting element: an identical answer moves and replaces nothing', async () => {
	const html = menu([1, 2, 3], () => true, true);
	const host = mount('so-menu', html);
	const before = [...host.childNodes];
	let records = 0;
	const mo = new MutationObserver((rs) => (records += rs.length));
	mo.observe(host, { childList: true });
	morph_children(host, parse(html));
	await Promise.resolve();
	mo.disconnect();
	expect(records).toBe(0);
	expect([...host.childNodes].every((n, i) => n === before[i])).toBe(true);
});

test('an element that renders its own light DOM (no shadow root) keeps its arrangement: an identical answer moves nothing', async () => {
	const html = '<!--[-->' + panel(1) + '<!--]--><!--[-->' + panel(2) + '<!--]-->';
	const host = document.createElement('so-shell');
	host.innerHTML = html;
	document.body.append(host); // connecting, its runtime moves the panels after the markers
	const arranged = all(host);
	expect(arranged).not.toEqual(shape(html, all));
	let records = 0;
	const mo = new MutationObserver((rs) => (records += rs.length));
	mo.observe(host, { childList: true });
	morph_children(host, parse(html));
	await Promise.resolve();
	mo.disconnect();
	expect(records).toBe(0);
	expect(all(host)).toEqual(arranged);
});
