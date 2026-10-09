/**
 * LATE-REGION capture — the registry front for streamed `<Region of={promise}>` holes. Same shape
 * as the page-seed / setContext recorders: the SERVER installs a request-scoped recorder (ALS-backed
 * in `hooks.ts`), Region.svelte calls the plain function during SSR, and on the client (or with no
 * recorder armed) it is a no-op returning `null` — the region keeps today's placeholder behavior.
 *
 * When armed, registering a promise returns the SLOT ID the region wraps its placeholder in
 * (`<og-late-slot data-og-slot=…>`); the router's streamed-document path later drains the request's
 * registered promises in completion order, baking each resolved region into a late template chunk
 * down the same response. That is "streamed load data" in ogygia's model: a load hands a promise to
 * a region, and the region resolves over the initial connection — no client refetch, no second
 * round trip, islands inside waking on adoption.
 */

type LateRecorder = (promise: Promise<unknown>) => string | null;

type ScopeOpener = () => void;
let opener: ScopeOpener | null = null;

/** Server (`hooks.ts`) installs the request-scoped scope opener. */
export function set_late_scope_opener(fn: ScopeOpener | null): void {
	opener = fn;
}

/**
 * ONLY A RENDERER THAT DELIVERS LATE CHUNKS ARMS THEM. The server router's streamed document opens
 * this request's late scope before it renders (and drains it after); anywhere else — a Kit page render
 * — a promise `of` registers nothing, because nothing would ever fill its slot (a Kit page's header
 * sat in an empty slot forever).
 */
export function open_late_scope(): void {
	opener?.();
}

let recorder: LateRecorder | null = null;

/** Server (`hooks.ts`) installs the request-scoped recorder. */
export function set_late_recorder(fn: LateRecorder | null): void {
	recorder = fn;
}

/** Region.svelte calls this with a promise `of` during SSR. `null` = not armed → no streaming. */
export function register_late_region(promise: Promise<unknown>): string | null {
	return recorder ? recorder(promise) : null;
}

export interface LateRegion {
	id: string;
	promise: Promise<unknown>;
}

type LateTaker = () => LateRegion[] | null;
let taker: LateTaker | null = null;

/** Server (`hooks.ts`) installs the request-scoped drain alongside the recorder. */
export function set_late_taker(fn: LateTaker | null): void {
	taker = fn;
}

/** The router drains THIS request's registered late regions after the document render (through
 *  this seam, never by importing hooks — its `virtual:` imports don't resolve outside Vite).
 *  `null` when nothing registered / nothing armed. Draining clears the request's list. */
export function take_late_regions(): LateRegion[] | null {
	return taker ? taker() : null;
}
