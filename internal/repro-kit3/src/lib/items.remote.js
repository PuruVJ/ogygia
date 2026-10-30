import { form, query } from '$app/server';
import { Point } from './point.js';

/** @type {string[]} */
const items = ['first'];

export const list_items = query(() => [...items]);

// A successful submit makes Kit 3's form call `refreshAll` (the import every Kit 3 build lacked).
export const add_item = form('unchecked', async (/** @type {{ text?: string }} */ data) => {
	if (data.text) items.push(data.text);
	return { added: data.text };
});

export const sum_point = query('unchecked', (/** @type {Point} */ p) => {
	if (!(p instanceof Point)) throw new Error('not a Point');
	return p.x + p.y;
});
