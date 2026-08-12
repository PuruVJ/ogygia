// Plain Svelte 5 module state. No ogygia here yet — this is the "does it already share?" probe.
class Cart {
	items = $state<string[]>([]);
	get count() {
		return this.items.length;
	}
	add(item: string) {
		this.items.push(item);
	}
	clear() {
		this.items = [];
	}
}

export const cart = new Cart();
