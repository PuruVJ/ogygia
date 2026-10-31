/**
 * A transportable live object: real class, `$state` field, methods, getter.
 * The `static wire = import.meta.og.wire({...})` codec is the entire opt-in — the vite plugin
 * registers it, encode ships { label, count }, decode rebuilds a live instance.
 */
export class SharedCounter {
	label: string;
	count = $state(0);

	constructor(label: string, count = 0) {
		this.label = label;
		this.count = count;
	}

	get double() {
		return this.count * 2;
	}

	inc() {
		this.count += 1;
	}

	static wire = import.meta.og.wire({
		encode: (c: SharedCounter) => ({ label: c.label, count: c.count }),
		decode: (d: { label: string; count: number }) => new SharedCounter(d.label, d.count)
	});
}
