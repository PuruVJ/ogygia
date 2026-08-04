import { getOrder } from '$lib/server/db.js';
import { error } from '@sveltejs/kit';

export function load({ params }) {
	const id = Number(params.id);
	const order = getOrder(id);
	if (!order) error(404, `Order ${params.id} not found`);
	return { order, prevId: id > 1 ? id - 1 : null, nextId: id < 240 ? id + 1 : null };
}
