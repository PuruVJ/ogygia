/**
 * Server-side capture for the page snapshot ($page.data / form / error / status) islands read through
 * the `$app/state` shim. The handle CANNOT read the resolved load data: Kit merges it locally in
 * `render.js` (`data = { ...data, ...branch[i].data }`) and never stores it on `RequestState`, and
 * reading `$app/state`'s `page` inside a handle hook throws `lifecycle_outside_component`. So a
 * COMPONENT rendered during SSR (Region.svelte) — where Kit's REAL `$app/state` page is available —
 * records it HERE, and the handle merges it into the `application/ogygia-page` seed. That's how
 * `$page.data` works inside islands on a csr=false page (boundary law: page.data crosses).
 *
 * Same shape as the setContext recorder: the server installs the recorder (ALS-backed in `hooks.ts`),
 * so it is universal-safe — on the client `record_page` is a no-op (no recorder installed).
 */
export type PageSnapshot = {
	data?: unknown;
	form?: unknown;
	error?: unknown;
	status?: number;
	/** Set by the routeless document root (the router's seed) so nested island renders under the
	 *  server router see the page's real url/params/route, not the request's bare event. */
	url?: { href?: string };
	params?: Record<string, string | undefined>;
	route?: { id: string | null };
};

type Recorder = (snapshot: PageSnapshot) => void;

let recorder: Recorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped recorder. */
export function set_page_recorder(fn: Recorder | null): void {
	recorder = fn;
}

/** Region.svelte calls this during SSR with Kit's real page; the client is a no-op. */
export function record_page(snapshot: PageSnapshot): void {
	recorder?.(snapshot);
}
