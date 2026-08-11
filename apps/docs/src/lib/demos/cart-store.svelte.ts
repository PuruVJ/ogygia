import * as ogygia from 'ogygia';

/** Live cart that crosses island boundaries as a prop (`static [ogygia.wire]`). */
export class Cart {
	items = $state<string[]>([]);

	get count() {
		return this.items.length;
	}

	add(item: string) {
		this.items.push(item);
	}

	static [ogygia.wire] = {
		encode: (c: Cart) => $state.snapshot(c.items),
		decode: (items: string[]) => Object.assign(new Cart(), { items })
	};
}

/** The same live `Cart`, provided to a subtree instead of drilled as a prop through every island. */
export const cartCtx = ogygia.createContext<Cart>();
