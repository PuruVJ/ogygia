/**
 * KIT-WORLD PAGE THREAD (wait side). On a Kit-hydrated (csr=true) document the handle ships no
 * `application/ogygia-page` seed — Kit's own data blob is the truth, and the `$app/state` shim reads
 * it through the bridge Kit's generated client entry publishes on `Symbol.for('ogygia.kit-page')`
 * (KIT_PAGE_THREAD in vite/index.ts; read side in shims/page-store.svelte.ts).
 *
 * That entry arrives by Kit's boot `import()` — a network fetch — while an island of OURS on that
 * document (inside a lake, inside a hole's answer) is already in the SSR tree and wakes on its own
 * schedule. `wake:'idle'` fires while the browser waits for Kit's chunks. The island then hydrated
 * with `kit_bridge() === null` → `page.data` read `{}` → a `{#if page.data.x}` took the other
 * branch → Svelte discarded the island's server DOM and re-rendered it EMPTY (a customer's header
 * search bar, ~1 in 3 loads — a race, so it looked erratic). The whole point of the bridge is that
 * such an island sees Kit's page; so an island of ours on a Kit document waits for the bridge before
 * its hydrate turn. Its server HTML stays on screen meanwhile — waiting costs nothing visible, a
 * discard costs the island.
 *
 * The wait is an ACCESSOR on the symbol: the entry's plain assignment resolves it, whatever order
 * the two worlds load in. `null` when the bridge is already there (the common late-wake case: a
 * fetched hole's islands, a click long after boot) — the caller skips the await entirely.
 */
const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');

type Global = Record<symbol, unknown>;

let pending: Promise<void> | null = null;

export function kit_page_thread(): Promise<void> | null {
	const g = globalThis as unknown as Global;
	if (g[KIT_PAGE_KEY] != null) return null;
	return (pending ??= new Promise<void>((resolve) => {
		let value: unknown;
		const settle = (v: unknown) => {
			value = v;
			// Back to a plain data property: the accessor was only ever a one-shot latch.
			Object.defineProperty(g, KIT_PAGE_KEY, {
				value: v,
				writable: true,
				configurable: true,
				enumerable: true
			});
			pending = null;
			resolve();
		};
		try {
			Object.defineProperty(g, KIT_PAGE_KEY, {
				configurable: true,
				enumerable: true,
				get: () => value,
				set: settle
			});
		} catch {
			// A global that refuses accessors (a sealed sandbox): poll instead — same contract, later.
			const tick = () => (g[KIT_PAGE_KEY] != null ? settle(g[KIT_PAGE_KEY]) : setTimeout(tick, 50));
			tick();
		}
	}));
}
