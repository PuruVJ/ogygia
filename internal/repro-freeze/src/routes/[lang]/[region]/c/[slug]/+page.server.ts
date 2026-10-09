import { count_render, cms_read } from '$lib/server/state.js';
import { read_doc } from '$lib/server/sources.js';

/** The pure content page (the bcms landing-page shape): CMS body keyed by slug, PLUS a shared
 *  embedded doc ('promo') read through a DECLARED source — the one-doc-on-many-pages case the
 *  og.source reverse index exists for. No personalization anywhere. */
export function load({ url, params }) {
	const n = count_render(url.pathname);
	const doc = cms_read(params.slug);
	const promo = read_doc('promo');
	return {
		slug: params.slug,
		version: doc.version,
		body: doc.body,
		promo: { version: promo.version },
		render: n
	};
}
