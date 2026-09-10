/**
 * Detect whether this document is a Kit csr=true page (Kit boots and hydrates the tree).
 * Must NOT treat ogygia side-channel scripts as evidence — their payloads can reflect
 * attacker-controlled URL substrings like `__sveltekit_` (P0).
 */
export class KitBoot {
	static #ASSIGN = /__sveltekit_\w+\s*=/;
	static #SIDECHANNEL =
		/<script\b[^>]*(?:\bdata-ogygia-(?:props|page|remote)\b|type=["']application\/ogygia-(?:props|page|remote)["'])[^>]*>[\s\S]*?<\/script>/gi;
	static #INLINE = /<script\b(?![^>]*\bsrc=)[^>]*>[^<]*__sveltekit_\w+\s*=/i;

	static document_has(doc: ParentNode = document): boolean {
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

export const document_has_kit_bootstrap = KitBoot.document_has.bind(KitBoot);
export const html_has_kit_bootstrap = KitBoot.html_has.bind(KitBoot);
