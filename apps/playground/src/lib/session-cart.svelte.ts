import * as ogygia from 'ogygia';

/**
 * CONTINUITY — a NAMED transportable. `id: 'session-cart'` promotes the cart from page lifetime to
 * SESSION lifetime: the same live instance follows the visitor across SPA navigations, tab-scoped,
 * server never remembers. `serverStamp` is server truth (bumped per page render) — merge pulls it
 * in while user `items` (live) win.
 */
export class SessionCart {
	items = $state<string[]>([]);
	serverStamp: number;

	constructor(items: string[] = [], serverStamp = 0) {
		this.items = items;
		this.serverStamp = serverStamp;
	}

	get count() {
		return this.items.length;
	}

	add(item: string) {
		this.items.push(item);
	}

	static [ogygia.wire] = {
		id: 'session-cart',
		encode: (c: SessionCart) => ({ items: $state.snapshot(c.items), serverStamp: c.serverStamp }),
		decode: (d: { items: string[]; serverStamp: number }) =>
			new SessionCart(d.items, d.serverStamp),
		// user edits win; server truth (stamp) is refreshed each navigation
		merge: (live: SessionCart, fresh: SessionCart) => {
			live.serverStamp = fresh.serverStamp;
		}
	};
}
