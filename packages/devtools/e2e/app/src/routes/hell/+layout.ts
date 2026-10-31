// A UNIVERSAL load on the section layout: fetches the feature toggles "so the client has them too".
// On this csr=false page it runs on the server only; with a client router it would run again in
// the browser on every navigation.
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ fetch, data, url }) => {
	const res = await fetch(`${url.origin}/hell/api/toggles?ms=25`);
	const toggles = (await res.json()) as { name: string; ms: number };
	return { ...data, toggles };
};
