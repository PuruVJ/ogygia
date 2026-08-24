/**
 * Pure, UI-free helpers the devtools components share — region classification off the DOM attributes
 * the compiler already emits, resource-timing byte lookups, and event queries over the bus buffer.
 * No Svelte, no styling: the `.svelte` components own all presentation.
 */
import { snapshot } from './bus.js';
import type { DevtoolsEvent } from './schema.js';

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
	entry: string | null;
	fp: string | null;
	hydrated: boolean;
}

export function region_info(el: Element): RegionInfo {
	const kind = region_kind(el);
	return {
		el,
		kind,
		wake: el.getAttribute('wake') || (kind === 'hole' ? 'fetch' : 'load'),
		entry: el.getAttribute('entry'),
		fp: el.getAttribute('data-og-fp'),
		hydrated: el.hasAttribute('data-hydrated')
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
	let sib = el.nextElementSibling;
	while (sib) {
		if (sib.tagName === 'SCRIPT' && sib.matches('script[data-ogygia-props]')) return sib.textContent;
		if (sib.tagName === 'LINK') {
			sib = sib.nextElementSibling;
			continue;
		}
		break;
	}
	return null;
}

/** basename of a URL/path (drops query + directory). */
export function basename(url: string): string {
	return (url.split('?')[0].split('#')[0].split('/').pop() || url).trim();
}

/** basename without a trailing `.js`, for a compact chunk label. */
export function short_chunk(url: string | null): string {
	if (!url) return '';
	const b = basename(url).replace(/\.js$/, '');
	return b.length > 24 ? b.slice(0, 23) + '…' : b;
}

/** The island id (`<hash>` in `virtual:ogygia/island/<hash>.js`) from an entry URL, or ''. */
export function island_id(entry: string | null | undefined): string {
	if (!entry) return '';
	return basename(entry).replace(/\.js$/, '');
}

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
): { bytes: number; modules: number } | null {
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
	const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
	let found: PerformanceResourceTiming | undefined;
	for (const r of res) if (basename(r.name) === base) found = r; // last match wins (a re-fetch)
	return found;
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
