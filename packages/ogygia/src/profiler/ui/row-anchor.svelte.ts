/**
 * ROW ANCHORS — a finding links to the row it is about (`#comp=<name>`, `#fn=<key>`); the table
 * island opens that row and scrolls to it, on load and on every hash change. Shared by the two
 * tables: give it the anchor kind and a getter for the open state, get back the row id maker and
 * the effect to install.
 */
export type RowKind = 'comp' | 'fn' | 'island' | 'seed';

export function row_id(kind: RowKind, key: string): string {
	let h = 5381;
	for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0;
	return `row-${kind}-${h.toString(36)}`;
}

/** The `href` a finding uses to reach a row. */
export function row_href(anchor: string): string {
	const i = anchor.indexOf(':');
	return `#${anchor.slice(0, i)}=${encodeURIComponent(anchor.slice(i + 1))}`;
}

/** Install in a table island: opens the row named by the URL hash (if it is one of `keys`). */
export function follow_hash(kind: RowKind, keys: () => string[], open: (key: string) => void): () => void {
	const apply = () => {
		const m = /^#(comp|fn|island|seed)=(.*)$/.exec(location.hash);
		if (!m || m[1] !== kind) return;
		let key: string;
		try {
			key = decodeURIComponent(m[2]);
		} catch {
			return;
		}
		if (!keys().includes(key)) return;
		open(key);
		// after the row renders
		setTimeout(() => {
			document.getElementById(row_id(kind, key))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}, 30);
	};
	apply();
	window.addEventListener('hashchange', apply);
	return () => window.removeEventListener('hashchange', apply);
}
