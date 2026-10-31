// PLANTED slow first byte: the page's load waits 1 s, and says where its time went (Server-Timing:
// the database most of it). `?fast` answers at once (the redirect plant lands here).
export const load = async ({ url, setHeaders }) => {
	if (url.searchParams.has('fast')) return {};
	await new Promise((ok) => setTimeout(ok, 1000));
	setHeaders({ 'server-timing': 'db;desc="the database";dur=720, render;desc="the page render";dur=270' });
	return {};
};
