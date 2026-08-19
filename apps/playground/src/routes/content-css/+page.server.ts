// REGRESSION: a content BODY (`.svx`/`.md`) carries its own scoped `<style>`, but the leak-free
// corpus is server-only, so that CSS joins no page's static stylesheet. ogygia emits it as a client
// asset and Region.svelte links it via the content-css handoff. This route renders such a body on a
// csr=false page (root layout sets csr=false); e2e/content-css.ts asserts the CSS ships and applies.
//
// The collection lives in this server-only module (`+page.server.ts`), so its eager glob never drags
// the corpus into a client bundle — the exact stress the fix must survive.
import { content, markdown } from 'ogygia/content';

const docs = content({
	loader: markdown(import.meta.glob('../../content/content-css/**/+doc.svx', { eager: true }))
});

export const load = async () => {
	const [ref] = await docs.refs();
	const entry = ref ? await docs.get(ref.id) : null;
	return { body: entry?.body };
};
