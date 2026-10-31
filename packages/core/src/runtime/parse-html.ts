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

/** The app's transform reshaped this markup (server/reversible.ts): restore it before anything reads
 *  it. The restorer is the page's own (the handle inlines it only when the app has a transform), so
 *  the runtime carries none of it — without one, this is a no-op. */
export function restore_markup(root: ParentNode): void {
	(globalThis as { __og_restore?: (root: ParentNode) => number }).__og_restore?.(root);
}

/** Adopt the keyed sheets of roots restored outside the page, right after their insertion. */
export function restore_adopt_sheets(): void {
	(globalThis as { __og_restore_adopt?: () => void }).__og_restore_adopt?.();
}

/**
 * Shadow roots attached while the markup sat in an inert document — a declarative shadow root the
 * parse above attached, a restored one — get no custom element registry in a browser with scoped
 * registries, and keep none once inserted: nothing inside them upgrades (an element that calls
 * `attachInternals` in its constructor throws). Give each the page's registry, right after the
 * insertion. A browser without scoped registries never nulls it (and has no `initialize`): a no-op.
 */
export function init_shadow_registries(under: Node): void {
	const ce = customElements as CustomElementRegistry & { initialize?: (root: Node) => void };
	if (typeof ce.initialize !== 'function') return;
	const scopes: Node[] = [under];
	for (let q = 0; q < scopes.length; q++) {
		const walk = document.createTreeWalker(scopes[q], 1 /* SHOW_ELEMENT */);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			const sr = (n as Element).shadowRoot as (ShadowRoot & { customElementRegistry?: unknown }) | null;
			if (!sr) continue;
			if (sr.customElementRegistry === null) ce.initialize(sr);
			scopes.push(sr);
		}
	}
}
