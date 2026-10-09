/**
 * Server-side capture for the page snapshot ($page.data / form / error / status) islands read through
 * the `$app/state` shim. The handle CANNOT read the resolved load data: Kit merges it locally in
 * `render.js` (`data = { ...data, ...branch[i].data }`) and never stores it on `RequestState`, and
 * reading `$app/state`'s `page` inside a handle hook throws `lifecycle_outside_component`. So a
 * COMPONENT rendered during SSR (Region.svelte) — where Kit's REAL `$app/state` page is available —
 * records it HERE, and the handle merges it into the `application/ogygia-page` seed. That's how
 * `$page.data` works inside islands on a csr=false page (boundary law: page.data crosses).
 *
 * Same shape as the setContext recorder: the server installs the recorder (request-scoped in
 * `hooks.ts`), so it is universal-safe — on the client `record_page` is a no-op (no recorder
 * installed).
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
 * for server-side page reads), only the serialized seed is gated on it. Whether the seed ships is
 * read ONCE, by the handle, when the document tail renders — no region asks during the render.
 *
 * `remotes` — the same question for the REMOTE seed (`application/ogygia-remote`): which remote
 * modules (Kit id-hashes) this region's client code can call (`islandRemotes`, the build's chunk-
 * closure answer). `[]` = none (a lake, a static hole, the routeless document root); `null` =
 * fail-open, "may call anything" (a promise `of` whose module SSR cannot see, an entry the handoff
 * does not know, dev). The handle unions every record and seeds only the remotes some region can
 * reach — REMOTE SEED ONLY WHEN REACHABLE.
 */
/**
 * `seed` is now an ASK, not a flag (SEED SHAPING): `false` — this region's client never reads the
 * page (record the snapshot, ship nothing for it); `'all'` — it reads the page and the build could
 * not pin its `page.data` reads to literal keys (or does not know the entry: a promise `of`, a
 * foreign fragment, dev); a `string[]` — exactly these top-level `page.data` keys. The handle
 * unions the asks: any `'all'` ships the whole `page.data`, otherwise the union of keys.
 */
export type SeedAsk = import('./server/seed-shape.js').SeedAsk;

type Recorder = (
	snapshot: PageSnapshot,
	seed: SeedAsk,
	remotes: readonly string[] | null,
	/** the region's entry (`''` for a region with no client entry) — the seed explainer's "who" */
	entry: string
) => void;

let recorder: Recorder | null = null;

/** Server (`hooks.ts`) installs a request-scoped recorder. */
export function set_page_recorder(fn: Recorder | null): void {
	recorder = fn;
}

/** What the page's regions asked for so far this request: whether any wants the seed, and which
 *  `page.data` keys (`'all'` or a set; `null` until one asks). Undefined outside a request the
 *  handle owns (no reader installed, or no bag). The server router's document reads it after its
 *  render, so a router page seeds like a Kit page: only when an island reads it, only what is read. */
type AskReader = () => { wanted: boolean; keys: import('./server/seed-shape.js').SeedKeys | null } | undefined;
let ask_reader: AskReader | null = null;

/** Server (`hooks.ts`) installs the reader beside the recorder. */
export function set_seed_ask_reader(fn: AskReader | null): void {
	ask_reader = fn;
}

export function read_seed_ask(): ReturnType<AskReader> {
	return ask_reader?.();
}

/** Start collecting the regions' asks for a render outside a Kit page (the server router's document,
 *  answered before a Kit page bag exists): the next `record_page` calls of this request count, and
 *  `read_seed_ask` returns them. A no-op on the client or outside a request. */
let ask_opener: (() => void) | null = null;
export function set_ask_scope_opener(fn: (() => void) | null): void {
	ask_opener = fn;
}
export function open_ask_scope(): void {
	ask_opener?.();
}

/** Region.svelte calls this during SSR with Kit's real page; the client is a no-op. `seed: false`
 *  records the snapshot without asking for the client seed (no island on the page reads it);
 *  `remotes` names the remote modules this region's client can call (`null` = any). */
export function record_page(
	snapshot: PageSnapshot,
	seed: SeedAsk = 'all',
	remotes: readonly string[] | null = null,
	entry = ''
): void {
	recorder?.(snapshot, seed, remotes, entry);
}
