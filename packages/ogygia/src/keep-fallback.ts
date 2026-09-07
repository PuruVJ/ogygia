/**
 * `keepFallback()` — a server island's way to say "what the page already shows is right".
 *
 * A hole's `ogygiaFallback` is often the common case rendered in the page (an anonymous visitor's
 * actions slot, an eyebrow with no session); the hole exists for the other visitors. Calling
 * `keepFallback()` during the hole's server render ends it with no HTML: the endpoint answers
 * `204 No Content` (a batch parcel carries {@link KEEP_FALLBACK_HTML}), the runtime keeps the
 * fallback DOM as it is and marks the region done — no swap, no stylesheet wait, no bytes. Server
 * only: it throws a branded signal the handle recognises; in the browser a hole never renders.
 */
const KEEP = Symbol.for('ogygia.keep-fallback');

/** The parcel/store stand-in for "keep the fallback" — never applied to the DOM. */
export const KEEP_FALLBACK_HTML = '<!--ogygia:keep-fallback-->';

export class KeepFallbackSignal extends Error {
	constructor() {
		super('[ogygia] keepFallback(): the page fallback stands');
		this.name = 'KeepFallback';
		Object.defineProperty(this, KEEP, { value: true });
	}
}

/** End this server island's render: the page's fallback is the right content for this visitor. */
export function keepFallback(): never {
	throw new KeepFallbackSignal();
}

/** Did a hole render end with {@link keepFallback}? (the handle's catch reads this) */
export function is_keep_fallback(e: unknown): boolean {
	return !!e && typeof e === 'object' && (e as Record<symbol, unknown>)[KEEP] === true;
}
