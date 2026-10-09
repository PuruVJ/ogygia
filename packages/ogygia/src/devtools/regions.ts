/**
 * Pure, UI-free helpers the devtools components share — region classification off the DOM attributes
 * the compiler already emits, resource-timing byte lookups, and event queries over the bus buffer.
 * No Svelte, no styling: the `.svelte` components own all presentation.
 */
import { snapshot } from './bus.js';
import { props_sidecar_of } from '../runtime/sidecar.js';
import { tool_made } from '../tool-fetches.js';
import type { DevtoolsEvent } from './schema.js';
import type { IslandHazard } from '../profiler/hydration-hazards.js';

// ── regexes
const JS_EXT_RE = /\.js$/;

/** Region kind, from the two dials the compiler stamps. */
export type RegionKind = 'island' | 'lake' | 'hole';

export function region_kind(el: Element): RegionKind {
	if (el.getAttribute('render') === 'defer') return 'hole';
	if (el.getAttribute('wake') === 'none') return 'lake';
	return 'island';
}

/** One region's identity + live state, read straight off its `<ogygia-region>`. */
export interface RegionInfo {
	el: Element;
	kind: RegionKind;
	wake: string;
	/** its identity (the stable URL every name and key uses) */
	entry: string | null;
	/** its location: the content-hashed file it loads (a build names one; else the entry) */
	src: string | null;
	fp: string | null;
	hydrated: boolean;
	/** a region inside an awake island: it does not wake itself, it rides the island's hydration
	 *  (`data-nested`) — awake when that island is, with no `data-hydrated` of its own */
	rides?: Element;
}

export function region_info(el: Element): RegionInfo {
	const kind = region_kind(el);
	const parent = el.hasAttribute('data-nested') ? (el.parentElement?.closest('ogygia-region') ?? undefined) : undefined;
	return {
		el,
		kind,
		wake: el.getAttribute('wake') || (kind === 'hole' ? 'fetch' : 'load'),
		entry: el.getAttribute('entry'),
		src: el.getAttribute('src'),
		fp: el.getAttribute('data-og-fp'),
		hydrated: el.hasAttribute('data-hydrated') || !!parent?.hasAttribute('data-hydrated'),
		...(parent ? { rides: parent } : {})
	};
}

/** Every `<ogygia-region>` on the page, as {@link RegionInfo}. */
export function all_regions(): RegionInfo[] {
	return Array.from(document.querySelectorAll('ogygia-region'), region_info);
}

/**
 * The raw devalue text of a region's `<script data-ogygia-props>` sidecar (the props that crossed the
 * boundary), or null. Mirrors the runtime's own sibling walk (skips `<link>` CSS hints). Returned as
 * TEXT so this module stays devalue-free; the detail view decodes it.
 */
export function region_props_sidecar(el: Element): string | null {
	// Keyed at the end of the body (by `data-og-fp`) or adjacent — the runtime's own lookup.
	return props_sidecar_of(el)?.textContent ?? null;
}

/** basename of a URL/path (drops query + directory). */
export function basename(url: string): string {
	return (url.split('?')[0].split('#')[0].split('/').pop() || url).trim();
}

/** basename without a trailing `.js`, for a compact chunk label. */
export function short_chunk(url: string | null): string {
	if (!url) return '';
	const b = basename(url).replace(JS_EXT_RE, '');
	return b.length > 24 ? b.slice(0, 23) + '…' : b;
}

/** The island id from an entry URL, or '': `<id>` in the dev server's `virtual:ogygia/island/<id>.js`
 *  and in a build's `og-region.<id>.js` (the name maps key the bare id — with the prefix left on, every
 *  tab in a build showed hashes). */
export function island_id(entry: string | null | undefined): string {
	if (!entry) return '';
	const id = basename(entry).replace(JS_EXT_RE, '');
	return id.startsWith(BUILT_PREFIX) ? id.slice(BUILT_PREFIX.length) : id;
}
const BUILT_PREFIX = 'og-region.';

/**
 * The compiler's `island id → component name` map (dev-only), published on `window` by the
 * `virtual:ogygia/devtools-names` side-effect module the runtime/devtools boot pulls in. Empty off a
 * devtools build. Lets every tab label a region "Counter" instead of a hashed entry.
 */
export function region_names(): Record<string, string> {
	return (typeof window !== 'undefined' && window.__ogygia_region_names) || {};
}

/** Component name for an island entry URL, or `short_chunk(entry)` when unknown. */
export function region_name(entry: string | null | undefined): string {
	const id = island_id(entry);
	return (id && region_names()[id]) || short_chunk(entry ?? null);
}

/**
 * Transitive dev size for an island entry — the compiler's module-graph estimate (wrapper +
 * component + everything imported), published on `window.__ogygia_region_bytes` by the dock's mount
 * fetch. `null` when the island is still cold (never woken → no subgraph yet) or off a dev build.
 */
export function region_transitive(
	entry: string | null | undefined
): { bytes: number; modules: number; top?: { file: string; bytes: number }[]; barrels?: { file: string; fanout: number }[]; hazards?: IslandHazard[] } | null {
	const id = island_id(entry);
	const map = (typeof window !== 'undefined' && window.__ogygia_region_bytes) || null;
	return (id && map && map[id]) || null;
}

/** Component name for a region fingerprint — joined to its live `<ogygia-region>` in the DOM. */
export function region_name_by_fp(fp: string | null | undefined): string {
	if (!fp || typeof document === 'undefined') return fp || '';
	const el = document.querySelector(`ogygia-region[data-og-fp="${CSS.escape(fp)}"]`);
	const entry = el?.getAttribute('entry');
	const name = entry ? region_name(entry) : '';
	return name || fp;
}

/** kB with one decimal. */
export function kb(bytes: number): string {
	return (bytes / 1024).toFixed(1) + ' kB';
}

/** Resource-timing entry for a chunk, matched by hashed basename (unique per build). */
export function timing_for(entry: string): PerformanceResourceTiming | undefined {
	if (typeof performance === 'undefined') return undefined;
	const base = basename(entry);
	if (!base) return undefined;
	return timing_index().get(base);
}

// the resource list by basename, rebuilt only when it grows: every island asked on every tick, and
// each ask split every resource's URL (18 ms per 3 s on a page with 64 files and 30 islands)
let index_len = -1;
let index = new Map<string, PerformanceResourceTiming>();
function timing_index(): Map<string, PerformanceResourceTiming> {
	const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
	if (res.length !== index_len) {
		index = new Map();
		// last match wins (a re-fetch), the devtools' own reads left out (a HEAD's empty body is no size)
		for (const r of res) if (!tool_made(r)) index.set(basename(r.name), r);
		index_len = res.length;
	}
	return index;
}

/** Over-the-wire + decoded bytes for a chunk entry (0/0 when not yet loaded or size hidden). */
export function chunk_bytes(entry: string): { wire: number; raw: number; loaded: boolean } {
	const t = timing_for(entry);
	if (!t) return { wire: 0, raw: 0, loaded: false };
	const wire = t.encodedBodySize || t.transferSize || t.decodedBodySize || 0;
	const raw = t.decodedBodySize || wire;
	return { wire, raw, loaded: true };
}

/** Latest buffered event matching a predicate (newest wins), or null. */
export function latest_event(pred: (e: DevtoolsEvent) => boolean): DevtoolsEvent | null {
	const events = snapshot();
	for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return events[i];
	return null;
}
