/**
 * OGYGIA'S OWN COST PER REQUEST — what the handle added to a Kit page: the transform's wall time,
 * how many islands' sidecars and hints went to the tail, and the bytes of every side-channel
 * (page seed, remote seed, props tail, fn manifest, context bridge).
 *
 * The handle (hooks.ts) writes one record per page request; the profiler reads it back when it
 * finalizes the request's log entry, so a report can say "ogygia: 4 ms, seed 292 KB, props 131 KB
 * over 21 islands" and a finding can point at an oversized seed. Keyed by the `Request` in a
 * WeakMap — the record dies with the request, nothing is deleted, and the two modules never
 * import each other (hooks.ts imports the profiler lazily; the profiler must not import hooks).
 *
 * DETAIL is opt-in (`set_request_stats_detail`): the profiler turns it on for the length of a
 * recording, and only then does the handle spend anything on the per-island rows, the seed
 * explainer and the hole notes below. Off, a request pays one WeakMap write of the totals.
 */

/** One island's row in the report's Islands table. */
export interface IslandStat {
	fp: string;
	/** the island's source entry (what the handoff keys on) */
	entry: string;
	/** the component's name (Svelte's SSR function name, `ProductCard`); '' when unknown */
	name: string;
	/** the client module URL the region imports: its LOCATION (the content-hashed file served), not
	 *  its identity (`entry`) */
	module_url: string;
	/** `load` | `idle` | `visible` | `interaction` | a media query */
	wake: string;
	/** the props sidecar as shipped */
	props_bytes: number;
	/** canonical (unreferenced) props size — what the fingerprint hashes */
	canonical_bytes: number;
	/** the sidecar took the JSON lane */
	json: boolean;
	/** the first leaf that kept the props off the JSON lane, when devalue was used */
	culprit: string | null;
	/** seed references written into the sidecar, and the top-level page.data keys they point at */
	refs: number;
	ref_keys: string[];
	/** the module-preload hrefs this island contributed (its JS closure) */
	hints: string[];
	/** what the build saw in the island's components (handlers, $state, bind:, use:) */
	interactivity: IslandInteractivity | null;
	/** how many regions on the page share this fingerprint */
	count: number;
	/** a grouped row (`group_islands`): how many distinct fingerprints it merged */
	variants?: number;
}

export interface IslandInteractivity {
	handlers: number;
	state: number;
	effects: number;
	binds: number;
	actions: number;
	/** `.svelte` files in the island's closure that were scanned */
	files: number;
}

/** One top-level `page.data` key in the seed explainer. */
export interface SeedKeyStat {
	key: string;
	/** serialized size estimate of the value */
	bytes: number;
	/** islands whose client code reads this key (the build's answer) */
	readers: string[];
	/** islands whose props sidecar points into this key (seed references) */
	referenced_by: string[];
	shipped: boolean;
	/** why it ships: read by an island, referenced by a sidecar, or some island reads the page whole */
	reason: 'read' | 'referenced' | 'whole' | null;
}

/** A deferred hole the page rendered (its fallback in the shell, its content on the endpoint). */
export interface HoleStat {
	/** region id (the server manifest key) */
	id: string;
	/** the component's name (`Recommendations`); '' when unknown */
	name: string;
	/** a short preview of the props (`{"forProduct":"P1"}`), what tells two holes of one component apart */
	props: string;
	/** fetch schedule (`load` | `visible` | …) */
	when: string;
	/** phase-2 wake, when it hydrates */
	hydrate: string | null;
	/** response cache max-age in seconds (0 = no-store) */
	ttl: number;
	count: number;
	/** each copy by its key (runtime/hash.ts `hole_copy_key`) with its props preview — what the
	 *  browser's report and the hole's requests name a copy by (at most 12) */
	copies?: { p: string; props: string }[];
}

export interface OgygiaRequestStats {
	/** wall ms of `inject_client_seeds` (locate, dedupe, tail render, seed serialize, assemble) */
	transform_ms: number;
	/** props sidecars in the tail (one per distinct island fingerprint) */
	islands: number;
	/** module-preload hints in the tail */
	hints: number;
	/** deferred holes recorded in the tail (Kit-hydrated documents only) */
	holes: number;
	/** bytes of the `application/ogygia-page` seed ('' → 0) */
	seed_bytes: number;
	/** bytes of the `application/ogygia-remote` seed */
	remote_seed_bytes: number;
	/** bytes of the whole tail (hints + props sidecars + holes record) */
	tail_bytes: number;
	/** bytes of the og.$ factory manifest script */
	fnm_bytes: number;
	/** bytes of the drop-in setContext bridge */
	ctx_bytes: number;
	/** whether the seed went out on the JSON lane (else devalue) */
	seed_json: boolean;
	/** the first leaf that kept the SEED off the JSON lane, when devalue was used */
	seed_culprit?: string | null;
	// ── detail (only while the profiler records) ──
	island_rows?: IslandStat[];
	seed?: {
		keys: SeedKeyStat[];
		/** islands that read `page.data` whole (`'all'` asks) — the reason everything ships */
		whole_by: string[];
	};
	hole_rows?: HoleStat[];
}

/** What the islands endpoint did for one hole request. */
export interface HoleRequestStats {
	kind: 'hole';
	id: string;
	/** `hit` served from the render cache; `miss` rendered and stored; `none` = no cache (ttl 0) */
	cache: 'hit' | 'miss' | 'none';
	ttl: number;
	/** ms it waited for a render slot (the server renders a few holes at a time); absent on a hit */
	queue_ms?: number;
	/** its component's name (the server manifest's): names the hole where no page row does */
	name?: string;
	/** which copy (runtime/hash.ts `hole_copy_key` of its props payload): copies share the id */
	p?: string;
}

const stats = new WeakMap<Request, OgygiaRequestStats>();
const hole_stats = new WeakMap<Request, HoleRequestStats>();
let detailed = false;

export function record_request_stats(request: Request, s: OgygiaRequestStats): void {
	stats.set(request, s);
}

export function request_stats_of(request: Request): OgygiaRequestStats | undefined {
	return stats.get(request);
}

export function record_hole_stats(request: Request, s: HoleRequestStats): void {
	hole_stats.set(request, s);
}

export function hole_stats_of(request: Request): HoleRequestStats | undefined {
	return hole_stats.get(request);
}

/** One hole rendered inside a BATCH request (the page's first-load holes, a navigation's): the
 *  profiler logs each as its own hole request, timed by its own render within the batch. */
export interface BatchHoleStats extends HoleRequestStats {
	/** the hole's own time in the batch: its wait for a slot and its render (ms) */
	ms: number;
	/** 200 rendered; 500 its render failed */
	status: number;
}

/** The batch streams: its holes settle AFTER the handle returned (and the profiler logged the
 *  request), so each is handed on as it lands — to the profiler that asked, or nowhere. */
let batch_listener: ((request: Request, s: BatchHoleStats) => void) | null = null;

export function set_batch_hole_listener(fn: ((request: Request, s: BatchHoleStats) => void) | null): void {
	batch_listener = fn;
}

export function has_batch_hole_listener(): boolean {
	return batch_listener !== null;
}

export function record_batch_hole_stats(request: Request, s: BatchHoleStats): void {
	batch_listener?.(request, s);
}

/**
 * The profiler turns detail on for a recording; off, the handle records totals only. COUNTED, not a
 * switch: the flag is the process's, while a recorder lock is one profiler instance's — and two can
 * live at once (the dev server re-runs the app's hooks on an edit and `ogygia.handle()` builds a new
 * profiler, while the old one's sample and trap timers still record). The first window to end then
 * turned detail off under the other's render: its report kept no island rows ("islands 1, rows 0")
 * and named its islands by their files. On while any window records.
 */
export function set_request_stats_detail(on: boolean): void {
	detail_depth = on ? detail_depth + 1 : Math.max(0, detail_depth - 1);
	detailed = detail_depth > 0;
}
let detail_depth = 0;

export function request_stats_detailed(): boolean {
	return detailed;
}
