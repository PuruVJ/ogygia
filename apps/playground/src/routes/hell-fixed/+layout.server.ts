// The section layout's load: the session (an upstream call) and the flags, the way a site shell
// fetches them for every page underneath. The page's own load awaits `parent()` before it starts
// its calls — the classic chain.
import type { LayoutServerLoad } from './$types';
import { span } from 'ogygia/profiler';

export const load: LayoutServerLoad = async ({ url, fetch }) => {
	const session = await span('svc.session', async () => {
		const res = await fetch(`${url.origin}/hell/api/session?ms=45`);
		return (await res.json()) as { name: string; ms: number };
	});
	const flags = await span('svc.flags', async () => {
		const res = await fetch(`${url.origin}/hell/api/flags?ms=20`);
		return (await res.json()) as { name: string; ms: number };
	});
	return { session, flags, crumbs: [{ href: '/', label: 'crumb.home' }, { href: '/hell', label: 'crumb.catalog' }] };
};
