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
import { isHoleInline } from './context.js';

const KEEP = Symbol.for('ogygia.keep-fallback');

/** The message a misplaced `keepFallback()` fails with (a real error, not the signal). */
export const KEEP_FALLBACK_INLINE_MESSAGE =
	'[ogygia] keepFallback() ran inside the PAGE render: this server island is nested inside a `wake` island, ' +
	'where `render: "deferred"` is ignored and its component renders inline — nothing catches the signal there ' +
	'and its fallback never shows. Move the island out of the enclosing island (into the page, a layout, or a lake), ' +
	'or drop keepFallback() from a component that can render inline.';

/** The parcel/store stand-in for "keep the fallback" — never applied to the DOM. */
export const KEEP_FALLBACK_HTML = '<!--ogygia:keep-fallback-->';

export class KeepFallbackSignal extends Error {
	constructor() {
		super('[ogygia] keepFallback(): the page fallback stands');
		this.name = 'KeepFallback';
		Object.defineProperty(this, KEEP, { value: true });
	}
}

/** End this server island's render: the page's fallback is the right content for this visitor.
 *  Called from a server island rendering INLINE (nested in an island — the deferred mark is
 *  ignored there), the signal would escape to Kit's error page: fail with the reason instead. */
export function keepFallback(): never {
	let inline = false;
	try {
		inline = isHoleInline();
	} catch {
		/* outside component init (after an await on some runtimes): no context to read — the signal path */
	}
	if (inline) throw new Error(KEEP_FALLBACK_INLINE_MESSAGE);
	throw new KeepFallbackSignal();
}

/** Did a hole render end with {@link keepFallback}? (the handle's catch reads this) */
export function is_keep_fallback(e: unknown): boolean {
	return !!e && typeof e === 'object' && (e as Record<symbol, unknown>)[KEEP] === true;
}
