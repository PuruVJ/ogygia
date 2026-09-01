import { json } from '@sveltejs/kit';
import { artifacts } from 'ogygia/artifacts';
import { cms_publish } from '$lib/server/state.js';
import { read_doc } from '$lib/server/sources.js';

/**
 * The CMS "publish webhook": bump the doc, then invalidate. Body:
 *   { slug }               → exact URL invalidation (the v1 primary case)
 *   { prefix }             → subtree nuke (`invalidateWhere` — locale/section)
 *   { doc }                → og.source PRECISION: evict every page whose receipts name the doc
 */
export async function POST({ request }) {
	const body = (await request.json()) as { slug?: string; prefix?: string; doc?: string };
	if (body.slug) {
		const { version } = cms_publish(body.slug);
		await artifacts.invalidate(`/fr/fr/c/${body.slug}`);
		return json({ ok: true, version });
	}
	if (body.prefix) {
		await artifacts.invalidateWhere({ prefix: body.prefix });
		return json({ ok: true });
	}
	if (body.doc) {
		const { version } = cms_publish(body.doc);
		await artifacts.invalidate(read_doc, [body.doc]);
		return json({ ok: true, version });
	}
	return json({ ok: false }, { status: 400 });
}
