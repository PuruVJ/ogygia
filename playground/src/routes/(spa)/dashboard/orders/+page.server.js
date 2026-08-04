import { listOrders } from '$lib/server/db.js';

export function load({ url }) {
	const status = url.searchParams.get('status') || 'all';
	const sort = url.searchParams.get('sort') || 'id';
	const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
	const page = Number(url.searchParams.get('page') || '1') || 1;
	const { rows, total, pages } = listOrders({ status, sort, dir, page, perPage: 20 });
	return { rows, total, pages, page, status, sort, dir };
}
