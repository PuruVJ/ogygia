/**
 * CONTINUITY — native next-page speculation. Emits a Speculation Rules script so the browser
 * prerenders (or prefetches) same-origin links the visitor is likely to hit next. Combined with
 * PPR static shells these prerenders are nearly free, so navigation approaches instant.
 *
 * `'hover'` → `moderate` eagerness (the browser prerenders on hover / ~200ms pointer dwell).
 * `'viewport'` → `eager` (as links enter the viewport). Same-origin only; the app author opts in
 * because it assumes GET navigations are side-effect-free.
 *
 * We only DECLARE the rules; the browser owns the triggering, cross-document isolation, and the
 * throttle. Where Speculation Rules are unsupported it is a silent no-op (progressive enhancement).
 */
import { slots } from './slots.js';

/** Feature entry: install speculation rules if configured, and expose a reinstall for SPA re-add. */
export function install() {
	const mode =
		typeof __OGYGIA_CONTINUITY_SPECULATE__ !== 'undefined' ? __OGYGIA_CONTINUITY_SPECULATE__ : false;
	if (!mode) return;
	install_speculation(mode);
	// A client-injected speculation script does not survive the SPA head-merge — core re-adds it.
	slots.speculate = { reinstall: () => install_speculation(mode) };
}

export function install_speculation(mode: 'hover' | 'viewport' | false): void {
	if (!mode || typeof document === 'undefined') return;
	// Feature-detect: no support → do nothing (the ogygia router's own prefetch still applies).
	if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
	// Idempotent by DOM presence: a client-injected script does not ride an SPA head-merge, so the
	// router re-calls this after each navigation — re-add only if it was dropped.
	if (document.querySelector('script[data-ogygia-speculate]')) return;

	const eagerness = mode === 'viewport' ? 'eager' : 'moderate';
	const rules = {
		prerender: [
			{
				where: {
					and: [
						{ href_matches: '/*' }, // same-origin path links
						{ not: { href_matches: '/\u{1F3DD}️*' } }, // never the region endpoint
						{ not: { selector_matches: '[rel~=nofollow]' } },
						// `data-ogygia-speculate` cascade: `off` disables a subtree; `on` re-enables a link
						// (or subtree) inside an off region. `on` wins over `off`.
						{
							or: [
								{ not: { selector_matches: '[data-ogygia-speculate="off"], [data-ogygia-speculate="off"] *' } },
								{ selector_matches: '[data-ogygia-speculate="on"], [data-ogygia-speculate="on"] *' }
							]
						}
					]
				},
				eagerness
			}
		]
	};
	const script = document.createElement('script');
	script.type = 'speculationrules';
	script.setAttribute('data-ogygia-speculate', '');
	script.textContent = JSON.stringify(rules);
	document.head.appendChild(script);
}
