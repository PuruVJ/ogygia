// A deferred hole's fetched HTML can carry declarative shadow DOM — `<template shadowrootmode>` — when
// the region was server-rendered as web components (a standard, nothing library-specific). Those become
// real shadow roots ONLY through a DSD-aware parser. The old `region_fragment` used
// createContextualFragment, which is DSD-UNAWARE: the template stayed inert, so a host that draws its box
// from inside its shadow swapped in at 0 height and flickered until its runtime re-upgraded it. This is
// Repro A from the bug report: the region-parse path must attach the shadow root, like the document does.
import { expect, test } from 'vitest';
import { parse_region_html } from '../../src/runtime/parse-html.js';

const HTML =
	'<x-host><template shadowrootmode="open"><style>:host{display:block}</style><div>painted</div></template>light</x-host>';

test('parse_region_html attaches declarative shadow roots (unlike createContextualFragment)', () => {
	// Baseline: what the runtime did before — DSD-unaware, template left inert.
	const inert = document.createRange().createContextualFragment(HTML);
	const a = inert.querySelector('x-host')!;
	expect(a.shadowRoot).toBeNull();
	expect(a.querySelector('template[shadowrootmode]')).not.toBeNull();

	// The fix: the shadow root is attached and its content lives in the shadow, not the light DOM.
	const frag = parse_region_html(HTML);
	const host = frag.querySelector('x-host')!;
	expect(host.shadowRoot).not.toBeNull();
	expect(host.shadowRoot!.querySelector('div')?.textContent).toBe('painted');
	// The inert `<template>` is gone from the light DOM; only the real light child ("light") remains.
	expect(host.querySelector('template[shadowrootmode]')).toBeNull();
	expect(host.textContent).toBe('light');
});

test('nested declarative shadow DOM attaches at every level', () => {
	const nested =
		'<x-outer><template shadowrootmode="open">' +
		'<x-inner><template shadowrootmode="open"><span>deep</span></template></x-inner>' +
		'</template></x-outer>';
	const frag = parse_region_html(nested);
	const outer = frag.querySelector('x-outer')!;
	expect(outer.shadowRoot).not.toBeNull();
	const inner = outer.shadowRoot!.querySelector('x-inner')!;
	expect(inner.shadowRoot).not.toBeNull();
	expect(inner.shadowRoot!.querySelector('span')?.textContent).toBe('deep');
});

test('a closed shadowrootmode is honoured', () => {
	const frag = parse_region_html('<x-c><template shadowrootmode="closed"><b>x</b></template></x-c>');
	const host = frag.querySelector('x-c') as Element & { shadowRoot: ShadowRoot | null };
	// closed → not exposed via .shadowRoot, but the inert template must still be consumed
	expect(host.querySelector('template[shadowrootmode]')).toBeNull();
});

test('fallback (engine without setHTMLUnsafe) attaches DSD via the spec algorithm, recursively', () => {
	// Force the pre-setHTMLUnsafe path used by browsers that render DSD on first parse but lack the API.
	const proto = HTMLTemplateElement.prototype as { setHTMLUnsafe?: unknown };
	const real = Object.getOwnPropertyDescriptor(proto, 'setHTMLUnsafe');
	Object.defineProperty(proto, 'setHTMLUnsafe', { value: undefined, configurable: true });
	try {
		const nested =
			'<x-outer><template shadowrootmode="open">' +
			'<x-inner><template shadowrootmode="open"><span>deep</span></template></x-inner>' +
			'</template></x-outer>';
		const frag = parse_region_html(nested);
		const outer = frag.querySelector('x-outer')!;
		expect(outer.shadowRoot).not.toBeNull();
		const inner = outer.shadowRoot!.querySelector('x-inner')!;
		expect(inner.shadowRoot).not.toBeNull();
		expect(inner.shadowRoot!.querySelector('span')?.textContent).toBe('deep');
		// no inert template leaks into any light DOM
		expect(outer.querySelector('template[shadowrootmode]')).toBeNull();
	} finally {
		if (real) Object.defineProperty(proto, 'setHTMLUnsafe', real);
		else delete (proto as Record<string, unknown>).setHTMLUnsafe;
	}
});
