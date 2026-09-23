/**
 * KIT-WORLD PAGE THREAD (wait side). On a Kit-hydrated (csr=true) document the handle ships no
 * `application/ogygia-page` seed — Kit's own data blob is the truth, and the `$app/state` shim reads
 * it through the bridge Kit's generated client entry publishes on `Symbol.for('ogygia.kit-page')`
 * (KIT_PAGE_THREAD in vite/index.ts; read side in shims/page-store.svelte.ts).
 *
 * That entry arrives by Kit's boot `import()` — a network fetch — while an island of OURS on that
 * document (inside a lake, inside a hole's answer) is already in the SSR tree and wakes on its own
 * schedule. `wake:'idle'` fires while the browser waits for Kit's chunks. The island then hydrated
 * against an empty `page.data` → a `{#if page.data.x}` took the other branch → Svelte discarded the
 * island's server DOM and re-rendered it EMPTY (a customer's header search bar, ~1 in 3 loads — a
 * race, so it looked erratic). So an island of ours on a Kit document waits before its hydrate turn.
 * Its server HTML stays on screen meanwhile — waiting costs nothing visible, a discard costs the island.
 *
 * WHAT IS WAITED FOR — two moments, both exact, neither a guess:
 *
 *  1. The bridge is PUBLISHED. An accessor latch on the symbol: Kit's entry's plain assignment
 *     resolves it, whatever order the two worlds load in.
 *  2. Kit has APPLIED its page. The bridge holds a LIVE reference to Kit's `$app/state` page, assigned
 *     when the entry EVALUATES — but that page is still Kit's pre-start default until `start()`'s
 *     `initialize()` runs `update(result.props.page)`, ~150–350 ms later (field: bridge=Y with
 *     data.keys=0, the island hydrates and collapses, data lands 200 ms too late). A wait that
 *     resolved on (1) alone closed only the first window. Kit's page object carries the marker
 *     itself: it is constructed with `status = -1` (and a placeholder URL) and `update()` assigns the
 *     real status. `status !== -1` is "Kit applied its page" — for an EMPTY-data page too, which is
 *     why this is not "data has keys" (that cannot tell empty-applied from not-yet-applied, and only
 *     a timeout could paper over it). Every field of that page is a `$state.raw`, so the assignment
 *     is a reactive write and an effect reading `status` re-runs on it: the exact moment, no polling.
 *
 * Nothing here touches the `$page` store (removed in Kit 3): the `$app/state` page object is what
 * both Kit 2 and Kit 3 publish. No timeout either: a Kit document whose `start()` never runs has no
 * page truth for such an island to hydrate against, and its own Kit components are equally dead —
 * the island stays as its visible server HTML, which is the honest state.
 *
 * `null` when the page is already applied (the common late-wake case: a fetched hole's islands, a
 * click long after boot) — the caller skips the await entirely.
 */
const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');
/** Kit constructs its `$app/state` page with this status; `initialize()` replaces it with the real one. */
const KIT_PRE_START_STATUS = -1;

type Global = Record<symbol, unknown>;
type Bridge = { page?: { status?: number } } | null | undefined;

let pending: Promise<void> | null = null;

function bridge_of(): Bridge {
	return (globalThis as unknown as Global)[KIT_PAGE_KEY] as Bridge;
}

/** Reads Kit's live `status` — a reactive read when called inside an effect. */
function page_applied(bridge: Bridge): boolean {
	if (bridge == null) return false;
	try {
		return bridge.page?.status !== KIT_PRE_START_STATUS;
	} catch {
		return false;
	}
}

/**
 * DEV ONLY: after this long still waiting, say so once. The wait itself has no timeout by design (an
 * island of ours has no page truth to hydrate against until Kit applies its page, and its server HTML
 * is the honest state meanwhile) — but a Kit boot that never happens must be diagnosable, not silent.
 * Dead code in a production build.
 */
const DEV_STILL_WAITING_MS = 5000;

export function kit_page_thread(): Promise<void> | null {
	if (page_applied(bridge_of())) return null;
	return (pending ??= new Promise<void>((resolve) => {
		let slow: ReturnType<typeof setTimeout> | null = null;
		if (import.meta.env.DEV) {
			slow = setTimeout(() => {
				const bridge = bridge_of();
				console.warn(
					`[ogygia] islands inside a lake / hole answer on this Kit (csr=true) page have waited ${DEV_STILL_WAITING_MS / 1000}s ` +
						`for Kit to apply its page and are still holding their server HTML. ` +
						(bridge == null
							? `Kit's client entry has not evaluated (no page bridge yet) — Kit's boot script may be blocked, failing, or missing.`
							: `Kit's client entry evaluated but start() has not applied the page (status is still -1) — Kit's start() may have thrown; check the console above.`) +
						` They hydrate the moment Kit does; nothing is discarded meanwhile.`
				);
			}, DEV_STILL_WAITING_MS);
		}
		const done = () => {
			if (slow !== null) clearTimeout(slow);
			pending = null;
			resolve();
		};
		await_bridge((bridge) => await_applied(bridge, done));
	}));
}

/** Moment 1: the symbol is assigned. Calls back synchronously if it already is. */
function await_bridge(cb: (bridge: Bridge) => void): void {
	const g = globalThis as unknown as Global;
	if (g[KIT_PAGE_KEY] != null) return cb(g[KIT_PAGE_KEY] as Bridge);
	let value: unknown;
	const settle = (v: unknown) => {
		value = v;
		// Back to a plain data property: the accessor was only ever a one-shot latch.
		Object.defineProperty(g, KIT_PAGE_KEY, { value: v, writable: true, configurable: true, enumerable: true });
		cb(v as Bridge);
	};
	try {
		Object.defineProperty(g, KIT_PAGE_KEY, { configurable: true, enumerable: true, get: () => value, set: settle });
	} catch {
		// A global that refuses accessors (a sealed sandbox): the same contract, observed on a timer.
		const tick = () => (g[KIT_PAGE_KEY] != null ? settle(g[KIT_PAGE_KEY]) : setTimeout(tick, 50));
		tick();
	}
}

/** Moment 2: Kit assigns the real status onto its live page — observed by an effect, resolved once. */
function await_applied(bridge: Bridge, done: () => void): void {
	if (page_applied(bridge)) return done();
	const stop = $effect.root(() => {
		$effect(() => {
			if (!page_applied(bridge)) return;
			// Tear the root down outside its own run, then resolve.
			queueMicrotask(stop);
			done();
		});
	});
}
