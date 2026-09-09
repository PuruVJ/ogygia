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

/**
 * `seed` — does this record WANT the client seed shipped? Region.svelte passes the build's answer
 * for its island (`islandReadsPage`); the snapshot itself is always recorded (the handle also
 * reads it for the freeze verdict — a load with a streaming promise is per-request by intent — and
 * for server-side page reads), only the serialized seed is gated on it.
 */
type Recorder = (snapshot: PageSnapshot, seed: boolean) => void;

let recorder: Recorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped recorder. */
export function set_page_recorder(fn: Recorder | null): void {
	recorder = fn;
}

/** Region.svelte calls this during SSR with Kit's real page; the client is a no-op. `seed: false`
 *  records the snapshot without asking for the client seed (no island on the page reads it). */
export function record_page(snapshot: PageSnapshot, seed = true): void {
	recorder?.(snapshot, seed);
}

/**
 * Props sidecars deferred to the END of the body. An island rendered in Kit's own page pass hands
 * its `<script data-ogygia-props="<fp>">` here instead of emitting it next to the region; the handle
 * appends every recorded sidecar before `</body>` (after the content, before the page seed), one per
 * fingerprint. Same recorder shape as the page snapshot: `hooks.ts` installs a request-scoped one,
 * so any other render root (a hole endpoint, a baked held region, a router document, a test render)
 * gets `false` back and keeps the sidecar adjacent — the HTML stays self-contained wherever it is
 * spliced (runtime/sidecar.ts is the matching lookup).
 */
type PropsRecorder = (fp: string, script: string) => boolean;

let props_recorder: PropsRecorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped recorder; `null` uninstalls. */
export function set_props_recorder(fn: PropsRecorder | null): void {
	props_recorder = fn;
}

/** Region.svelte, SSR, Kit page pass only. `true` → recorded (emit nothing inline); `false` → no
 *  recorder for this render (emit the sidecar adjacent). */
export function record_island_props(fp: string, script: string): boolean {
	return props_recorder ? props_recorder(fp, script) : false;
}
