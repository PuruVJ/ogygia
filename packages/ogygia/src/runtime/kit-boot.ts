/**
 * Detect whether a document is a Kit csr=true page (Kit boots and hydrates the tree).
 * Must NOT treat ogygia side-channel scripts as evidence — their payloads can reflect
 * attacker-controlled URL substrings like `__sveltekit_` (P0).
 */
import { runtime_session } from './session.js';

export class KitBoot {
	static #ASSIGN = /__sveltekit_\w+\s*=/;
	static #SIDECHANNEL =
		/<script\b[^>]*(?:\bdata-ogygia-(?:props|page|remote)\b|type=["']application\/ogygia-(?:props|page|remote)["'])[^>]*>[\s\S]*?<\/script>/gi;
	static #INLINE = /<script\b(?![^>]*\bsrc=)[^>]*>[^<]*__sveltekit_\w+\s*=/i;

	/**
	 * The route fact, when the server stamped it: `<meta name="ogygia-csr" content="true">` on a
	 * csr=true document. `null` when the document carries no such meta (an older document, a
	 * fragment) — then the inline-script probe below decides.
	 */
	static meta_of(doc: ParentNode): boolean | null {
		const meta = doc.querySelector('meta[name="ogygia-csr"]');
		return meta ? meta.getAttribute('content') === 'true' : null;
	}

	/** Meta first; else ONE probe over the document's inline scripts (side-channel scripts skipped). */
	static document_has(doc: ParentNode = document): boolean {
		const meta = KitBoot.meta_of(doc);
		if (meta !== null) return meta;
		for (const s of doc.querySelectorAll('script:not([src])')) {
			const type = s.getAttribute('type') || '';
			if (type.startsWith('application/ogygia-')) continue;
			if (
				s.hasAttribute('data-ogygia-props') ||
				s.hasAttribute('data-ogygia-page') ||
				s.hasAttribute('data-ogygia-remote')
			)
				continue;
			if (KitBoot.#ASSIGN.test(s.textContent || '')) return true;
		}
		return false;
	}

	/** How far before `end` the string check looks. Kit appends its boot script at the END of the
	 *  body (render.js), right before `</body>`, so this window holds it whenever it exists. */
	static #WINDOW = 65_536;

	/**
	 * Same check over an HTML string, bounded to the last 64 KB before `end` (pass the index of
	 * `</body>`; defaults to the end of the string). A 2.6 MB document is never scanned whole: Kit's
	 * boot sits at the end of the body, so the window is exact, not a heuristic. The side-channel
	 * strip still applies inside the window (P0 above); a side-channel script cut by the window's
	 * start cannot false-match either — its payload never carries a literal `<script` (devalue and
	 * JSON escape `<`), and `#INLINE` needs one.
	 */
	static html_has(html: string, end = html.length): boolean {
		const window = html.slice(Math.max(0, end - KitBoot.#WINDOW), end);
		return KitBoot.#INLINE.test(window.replace(KitBoot.#SIDECHANNEL, ''));
	}
}

/**
 * Mixed mode: on a csr=true page, Kit boots and hydrates the whole tree (including our island
 * components). THE one answer for the live document — read once (the meta, else the probe), cached
 * on the session, cleared when the router prepares the next document. Every caller (the region
 * element's guards, the router's start, the wrapper's client leg) reads this cache; none probes
 * the document on its own.
 */
export function kit_hydrates_page(): boolean {
	if (runtime_session.kit_page === undefined) {
		runtime_session.kit_page = typeof document !== 'undefined' && KitBoot.document_has(document);
	}
	return runtime_session.kit_page;
}

export const html_has_kit_bootstrap = KitBoot.html_has.bind(KitBoot);
