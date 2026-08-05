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

	/** Same check over a full HTML string (server seed injection). */
	static html_has(html: string): boolean {
		const stripped = html.replace(KitBoot.#SIDECHANNEL, '');
		return KitBoot.#INLINE.test(stripped);
	}
}

export const document_has_kit_bootstrap = KitBoot.document_has.bind(KitBoot);
export const html_has_kit_bootstrap = KitBoot.html_has.bind(KitBoot);
