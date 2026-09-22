/**
 * THE one place region / SSR HTML becomes DOM. A leaf module (no imports) so every parse site shares
 * it: `region_fragment` (a fetched hole / live tick / held region), `repair_if_drifted` (the server
 * copy an island hydrates against), and anything added later. Having ONE parser is the point — a second,
 * DSD-unaware one would silently drift (see below).
 *
 * `<template shadowrootmode>` (declarative shadow DOM — a web STANDARD, nothing library-specific) turns
 * into a real shadow root ONLY when a DSD-aware parser reads it. `Element.setHTMLUnsafe()` is that
 * parser — the very algorithm the document uses on first load — so a server-painted region body arrives
 * with its shadow roots live, exactly as the initial page paints. `createContextualFragment` /
 * `innerHTML` / `DOMParser` are all DSD-UNAWARE by spec: they leave the `<template>` inert, so any host
 * that renders its box from inside its shadow paints at 0 height until its own runtime upgrades it (the
 * swap-then-blank-then-paint flicker). "Unsafe" means only "no sanitizer"; a region body is our own
 * signed, same-origin SSR (HOLE-TRUST), so it is exactly as trusted as the page itself.
 *
 * NOTE the parse happens in a `<template>`'s inert content, so custom elements do NOT upgrade here
 * (no `connectedCallback`) — attaching a declarative shadow root is a parse step, not an upgrade. That
 * is what `repair_if_drifted` needs: the server copy stays inert, but its light-DOM sequence is now
 * DSD-consistent with a live region whose hosts already carry shadow roots.
 */
export function parse_region_html(html: string): DocumentFragment {
	const tpl = document.createElement('template');
	const set_html_unsafe = (tpl as { setHTMLUnsafe?: (h: string) => void }).setHTMLUnsafe;
	if (typeof set_html_unsafe === 'function') {
		set_html_unsafe.call(tpl, html);
	} else {
		tpl.innerHTML = html;
		attach_declarative_shadows(tpl.content);
	}
	return tpl.content;
}

/** The spec's declarative-shadow-DOM attach step, for engines that render DSD on first parse but predate
 *  `setHTMLUnsafe`. Recurse into each shadow we attach: `querySelectorAll` stops at shadow boundaries,
 *  and a `<template shadowrootmode>` can nest inside another. First template per host wins (a host already
 *  carrying a shadow root is left as is). */
export function attach_declarative_shadows(root: DocumentFragment | ShadowRoot): void {
	for (const node of Array.from(root.querySelectorAll('template[shadowrootmode]'))) {
		const tpl = node as HTMLTemplateElement;
		const host = tpl.parentElement;
		tpl.remove();
		if (!host || host.shadowRoot) continue;
		const shadow = host.attachShadow({
			mode: tpl.getAttribute('shadowrootmode') === 'closed' ? 'closed' : 'open',
			delegatesFocus: tpl.hasAttribute('shadowrootdelegatesfocus')
		});
		shadow.append(tpl.content);
		attach_declarative_shadows(shadow);
	}
}
