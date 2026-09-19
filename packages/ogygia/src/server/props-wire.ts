/**
 * PROPS ON THE WIRE — one plan per island for what its props sidecar says, and how.
 *
 * Two facts about an island's props decide its sidecar, and both come from ONE walk of the props
 * (`analyze`, seed-refs.ts):
 *
 *  1. THE LANE. A payload that is plain JSON — objects, arrays, strings, finite numbers, booleans,
 *     null, nothing else — goes out as `JSON.stringify` output (native, ~10× cheaper than devalue's
 *     JavaScript flatten + per-character escape, which was the single hottest thing in a profiled
 *     CMS page's render) under `data-og-format="json"`, and the runtime reads it with `JSON.parse`.
 *     Anything devalue exists for (a Date, a Map, undefined, a bigint, a wired class, a store, a
 *     snippet, an og.$ fn) keeps the devalue lane with the usual reducers.
 *
 *  2. THE FINGERPRINT INPUT. `data-og-fp` hashes the CANONICAL text — the lane's text WITHOUT seed
 *     references. That makes the fingerprint a function of the props alone: the same props give the
 *     same fingerprint whether or not the page seed ships, and whichever island rendered first.
 *     (Before, an island rendered ahead of the page's first `$page` reader hashed a full copy and one
 *     rendered after it hashed the referenced text — two fingerprints for one island.)
 *
 * The wire text itself is produced LAST, when the document tail renders (server/document-tail.ts):
 * by then the request knows whether the seed ships, so `wire(seed)` serializes relative to it when
 * a props subtree is a seed node (seed-refs.ts) and falls back to the canonical text otherwise.
 * Every island on the page gets references, first island included — the old "islands before the
 * first reader ship copies" limitation is gone with the render-time decision.
 *
 * devalue output is `<`-safe by construction (it writes `<`); the JSON lane goes through
 * `escape_script_text` once. Neither is escaped a second time.
 *
 * Universal module (no Node imports): Region.svelte imports it on both legs; nothing here runs on
 * the client.
 */
import { stringify } from 'devalue';
import { escape_script_text } from '../escape.js';
import { REF_WIRE_KEY, ref_reducer } from '../ref.js';
import { register_wire_kind } from '../live-transport.js';
import { register_store_kind, register_derived_kind } from '../store-transport.js';
import { register_snippet_kind } from '../region-snippet.js';
import { register_fn_kind } from '../fn-transport.js';
import { analyze, json_culprit, plan_seed_refs, SEED_REF_KEY, type SeedIndex } from '../seed-refs.js';

/** The sidecar attribute naming a non-devalue payload format; absent = devalue. */
export const WIRE_FORMAT_ATTR = 'data-og-format';
/** The one non-devalue format: plain JSON, read with `JSON.parse`. */
export const WIRE_FORMAT_JSON = 'json';

/** Island props cross classes, stores, snippets, og.$ fns and resumable deriveds. */
const PROP_FAMILIES = new Set(['wire', 'store', 'snippet', 'fn', 'derived']);

// PULL-registration (idempotent in the hub registry; no import-time side effects) — done once per
// module instance, not once per island: five kind-object allocations per island added up on a page
// of twenty.
let kinds_registered = false;
function register_prop_kinds(): void {
	if (kinds_registered) return;
	kinds_registered = true;
	register_wire_kind();
	register_store_kind();
	register_snippet_kind();
	register_fn_kind();
	register_derived_kind();
}

/**
 * devalue-serialize an island's props with the prop families' reducers, plus the seed-reference
 * reducer when the caller has one. Throws a teaching error on a non-serializable prop.
 */
export function stringify_props(
	value: unknown,
	entry: string,
	seed_refs: ((v: unknown) => unknown) | null = null
): string {
	register_prop_kinds();
	try {
		// The seed reference goes FIRST: a node the seed owns is plain data — never a wired class, a
		// store, a snippet or an og.$ fn — so the families' mint (five kind matches per object) need
		// not run on it, and devalue never descends into it.
		const reducers: Record<string, (v: unknown) => unknown> = {};
		if (seed_refs) reducers[SEED_REF_KEY] = seed_refs;
		reducers[REF_WIRE_KEY] = ref_reducer(PROP_FAMILIES);
		return stringify(value, reducers);
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		throw new Error(
			`[ogygia] island "${entry}": a captured prop is not serializable — ${detail}. ` +
				`Captured host values cross the boundary via devalue; functions/Promises cannot, and a ` +
				`class instance only can when the class declares a static [ogygia.wire] codec. ` +
				`Pass a serializable value, add a codec, or move that logic inside the island component.`
		);
	}
}

/** A sidecar's text and the lane it is in. */
export interface WireText {
	text: string;
	json: boolean;
}

export interface PropsWire {
	/** The canonical, seed-independent text — what the fingerprint hashes. */
	readonly canonical: string;
	/** Whether the canonical text is plain JSON (the lane the props qualify for). */
	readonly json: boolean;
	/** Live region-snippet entry URLs riding in these props (the preloads they need). Only a
	 *  devalue payload can carry one — a live snippet is a branded function, never plain JSON. */
	readonly live_entries: readonly string[];
	/** The sidecar text for the wire. `seed` is the page seed's index when the seed ships (then a
	 *  props subtree that is a seed node crosses as a reference), `null` when it does not. */
	wire(seed: SeedIndex | null): WireText;
	/** The references the LAST `wire()` wrote: how many, into which top-level `page.data` keys. */
	readonly refs: { count: number; keys: readonly string[] };
	/** Why the canonical text is not JSON (the first disqualifying leaf); `null` on the JSON lane.
	 *  A separate walk, run on demand — the profiler's explainer, never the render path. */
	culprit(): string | null;
}

/**
 * Plan an island's sidecar: lane, canonical text, live snippet entries — and a `wire(seed)` that
 * produces the final text once the request knows about the seed (the document tail's render).
 * The wire text is produced once per seed: identical islands share one plan, and a tail rendered
 * twice against the same index (a test, a re-render) plans and serializes once.
 */
export function plan_props_wire(value: unknown, entry: string): PropsWire {
	const shape = analyze(value);
	const refs = { count: 0, keys: [] as string[] };
	const referenced = (seed: SeedIndex | null): WireText | null => {
		refs.count = 0;
		refs.keys = [];
		if (seed === null || seed.size === 0) return null;
		const plan = plan_seed_refs(seed, value);
		if (plan.count === 0) return null;
		refs.count = plan.count;
		refs.keys = [...plan.keys].sort();
		return { text: stringify_props(value, entry, plan.reducer), json: false };
	};
	let last_seed: SeedIndex | null | undefined;
	let last_text: WireText;
	const once = (seed: SeedIndex | null, plain: () => WireText): WireText => {
		if (seed === last_seed) return last_text;
		last_seed = seed;
		return (last_text = referenced(seed) ?? plain());
	};
	if (shape.json) {
		const canonical = JSON.stringify(value);
		let escaped: WireText | null = null;
		return {
			canonical,
			json: true,
			live_entries: [],
			wire: (seed) => once(seed, () => (escaped ??= { text: escape_script_text(canonical), json: true })),
			refs,
			culprit: () => null
		};
	}
	const canonical = stringify_props(value, entry, null);
	const plain: WireText = { text: canonical, json: false };
	let culprit: string | null | undefined;
	return {
		canonical,
		json: false,
		live_entries: live_entries_in(canonical),
		wire: (seed) => once(seed, () => plain),
		refs,
		culprit: () => (culprit === undefined ? (culprit = json_culprit(value)) : culprit)
	};
}

// Portable region-snippets riding an island's props come alive via `import(desc.e)` at hydrate;
// the payload embeds each descriptor's public entry URL (prod-shaped: `/<appDir>/immutable/
// og-region.<hash>.js`, any appDir). Found with `indexOf` hops — linear, no regex backtracking over
// a 300 KB payload (the old `[^"\s]+` scan was super-linear on long space-free tokens).
const LIVE_ENTRY_MARK = '/immutable/og-region.';
const LIVE_ENTRY_RE = /^\/[^"\s]+\/immutable\/og-region\.[0-9a-f]+\.js$/;
function live_entries_in(text: string): string[] {
	const out: string[] = [];
	let at = text.indexOf(LIVE_ENTRY_MARK);
	while (at !== -1) {
		const start = text.lastIndexOf('"', at) + 1;
		const end = text.indexOf('"', at);
		if (end === -1) break;
		const url = text.slice(start, end);
		if (LIVE_ENTRY_RE.test(url) && !out.includes(url)) out.push(url);
		at = text.indexOf(LIVE_ENTRY_MARK, end);
	}
	return out;
}

/**
 * The sidecar `<script>` for one island: keyed by fingerprint (`data-ogygia-props` for the
 * reconciler, `id` for an O(1) `getElementById` lookup by the runtime) when it has one, adjacent
 * and unkeyed otherwise; the format attribute names the JSON lane.
 */
export function props_sidecar(fp: string, w: WireText): string {
	return (
		'<script type="application/ogygia-props" data-ogygia-props' +
		(fp ? `="${fp}" id="og-props-${fp}"` : '') +
		(w.json ? ` ${WIRE_FORMAT_ATTR}="${WIRE_FORMAT_JSON}"` : '') +
		'>' +
		w.text +
		'</script>'
	);
}
