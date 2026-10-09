/**
 * BOUNDARY LAB — a stateful CLASS crossing islands via `import.meta.og.wire`.
 * `id: 'lab-cart'` promotes it to SESSION continuity: an SPA navigation reunites with the
 * SAME live instance (a cart mid-edit survives nav); `merge` pulls server truth in.
 */
export class LabCart {
	items = $state<string[]>([]);
	serverStamp = $state(0);

	add(item: string) {
		this.items.push(item);
	}
	get count() {
		return this.items.length;
	}

	static wire = import.meta.og.wire({
		encode: (c: LabCart) => ({ items: $state.snapshot(c.items), stamp: c.serverStamp }),
		decode: (d: { items: string[]; stamp: number }) =>
			Object.assign(new LabCart(), { items: d.items, serverStamp: d.stamp }),
		id: 'lab-cart',
		merge: (live: LabCart, fresh: LabCart) => {
			live.serverStamp = fresh.serverStamp; // server truth in; user's items win
		}
	});
}
