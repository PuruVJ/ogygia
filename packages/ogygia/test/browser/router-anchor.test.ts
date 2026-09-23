// The router's anchor lookup, in a real browser: a click that starts INSIDE a web component's
// shadow root is retargeted to the host by the time it reaches `document`, so `closest('a')` on
// `event.target` finds nothing — the SPA router then let the browser navigate natively (a full
// reload) for every web-component link (`<x-link>`, `<x-button href>`, breadcrumb
// items). `anchor_of` reads the composed path instead. Regression: the PES product page's "show
// all" back link and breadcrumb reloaded the document on ogygia while Kit swapped in place.
import { expect, test } from 'vitest';
import { anchor_of, reload_opt_out } from '../../src/runtime/router.js';

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

// `data-sveltekit-reload` — Kit's grammar, nearest ancestor wins. Regression: presence alone forced
// a full load, so a subtree opted back IN with `="false"` (an app's insights section under a
// `="true"` layout) reloaded on every link.
test('data-sveltekit-reload: bare and "true" opt out of the SPA; "off" and "false" opt in', () => {
	const anchor_in = (html: string) => {
		document.body.innerHTML = html;
		return document.querySelector('a')!;
	};
	expect(reload_opt_out(anchor_in('<a href="/x">x</a>'))).toBe(false);
	expect(reload_opt_out(anchor_in('<a href="/x" data-sveltekit-reload>x</a>'))).toBe(true);
	expect(reload_opt_out(anchor_in('<div data-sveltekit-reload="true"><a href="/x">x</a></div>'))).toBe(true);
	expect(reload_opt_out(anchor_in('<div data-sveltekit-reload="off"><a href="/x">x</a></div>'))).toBe(false);
	expect(reload_opt_out(anchor_in('<div data-sveltekit-reload="false"><a href="/x">x</a></div>'))).toBe(false);
});

test('data-sveltekit-reload: the nearest ancestor decides, either direction', () => {
	document.body.innerHTML =
		'<div data-sveltekit-reload="true"><section data-sveltekit-reload="false"><a id="in" href="/a">a</a><p data-sveltekit-reload><a id="out" href="/b">b</a></p></section><a id="top" href="/c">c</a></div>';
	expect(reload_opt_out(document.getElementById('in')!)).toBe(false); // layout says reload, section opts back in
	expect(reload_opt_out(document.getElementById('out')!)).toBe(true); // …and a bare attr below it opts out again
	expect(reload_opt_out(document.getElementById('top')!)).toBe(true); // only the layout applies here
});
