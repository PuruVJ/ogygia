// THE PAGE OF A RENDER (e2e/page-context.spec.ts): the facts a region rendered outside this page —
// a hole, a remote query or command — must see, looked up through Kit's data request.
export const load = ({ cookies, params }) => ({
	who: 'page-load',
	locale: cookies.get('pc_locale') ?? 'en',
	slug: params.slug
});
