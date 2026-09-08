// The router's anchor lookup, in a real browser: a click that starts INSIDE a web component's
// shadow root is retargeted to the host by the time it reaches `document`, so `closest('a')` on
// `event.target` finds nothing — the SPA router then let the browser navigate natively (a full
// reload) for every design-system link (`<qds-standalone-link>`, `<qds-button href>`, breadcrumb
// items). `anchor_of` reads the composed path instead. Regression: the PES product page's "show
// all" back link and breadcrumb reloaded the document on ogygia while Kit swapped in place.
import { expect, test } from 'vitest';
import { anchor_of } from '../../src/runtime/router.js';

/** Click `target`; run `anchor_of` INSIDE the document-level listener, as the router does — the
 *  composed path is only readable while the event dispatches. Prevented there too: a real anchor
 *  click would navigate the test iframe away. */
function click_and_resolve(target: Element): { target: EventTarget | null; anchor: HTMLAnchorElement | null } {
	let out: { target: EventTarget | null; anchor: HTMLAnchorElement | null } | null = null;
	const listener = (e: Event) => {
		out = { target: e.target, anchor: anchor_of(e) };
		e.preventDefault();
	};
	document.addEventListener('click', listener, { once: true });
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
	document.removeEventListener('click', listener);
	expect(out).not.toBeNull();
	return out!;
}

test('an anchor inside an open shadow root is found through the composed path', () => {
	document.body.innerHTML = '';
	const host = document.createElement('x-link');
	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = '<a href="/range/1"><span data-testid="inner">Tout afficher</span></a>';
	document.body.append(host);
	const r = click_and_resolve(root.querySelector('span')!);
	// retargeted at the document: the host, not the span — `closest('a')` on it finds nothing
	expect(r.target).toBe(host);
	expect((r.target as Element).closest('a')).toBeNull();
	expect(r.anchor?.getAttribute('href')).toBe('/range/1');
});

test('a light-DOM anchor (and a click on its descendant) still resolves', () => {
	document.body.innerHTML = '<a id="a" href="/x"><b id="b">x</b></a>';
	expect(click_and_resolve(document.getElementById('b')!).anchor?.id).toBe('a');
});

test('a click on nothing link-like is null, not an ancestor anchor of the host', () => {
	document.body.innerHTML = '<div><span id="s">plain</span></div>';
	expect(click_and_resolve(document.getElementById('s')!).anchor).toBeNull();
});
