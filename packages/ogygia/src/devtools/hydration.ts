/**
 * Every island's hydration status, from the bus (failed / recovered / healed), the beacon's
 * before-and-after markup (changed), the element (`data-og-recovered`, `data-hydrated`). Shared by
 * the Hydration tab and the testing API (`window.__ogygia_testing.hydration()`).
 */
import { snapshot } from './bus.js';
import { beacon_page } from '../runtime/beacon.js';
import { all_regions, region_name } from './regions.js';
import { html_diff, type HtmlDiff } from './html-diff.js';

export type HydrationStatus = 'failed' | 'recovered' | 'healed' | 'changed' | 'asleep' | 'clean';
export const STATUS_RANK: Record<HydrationStatus, number> = { failed: 0, recovered: 1, healed: 2, changed: 3, asleep: 4, clean: 5 };

export interface IslandHydration {
	fp: string;
	name: string;
	wake: string;
	status: HydrationStatus;
	reason: string;
	el: Element;
	snap: { ssr: string; hydrated: string } | null;
}

export function hydration_rows(): { rows: IslandHydration[]; measured: boolean } {
	const why = new Map<string, { status: HydrationStatus; reason: string }>();
	for (const e of snapshot()) {
		if (e.name === 'region.hydrate.failed') {
			if (e.fp) why.set(e.fp, { status: 'failed', reason: e.message.split('\n')[0] });
		} else if (e.name === 'region.hydrate.recovered') {
			if (e.fp) why.set(e.fp, { status: 'recovered', reason: e.reason ?? '' });
		} else if (e.name === 'region.hydrate.healed') {
			if (e.fp && why.get(e.fp)?.status !== 'recovered') why.set(e.fp, { status: 'healed', reason: e.reason ?? '' });
		} else if (e.name === 'region.hydrate.done') {
			if (e.fp && why.get(e.fp)?.status === 'failed') why.delete(e.fp);
		}
	}
	const page = beacon_page();
	const changed = new Set((page?.islands ?? []).filter((i) => i.changed).map((i) => i.fp));
	const snaps = new Map((page?.snapshots ?? []).map((s) => [s.fp, s]));
	const rows: IslandHydration[] = [];
	for (const r of all_regions()) {
		if (r.kind !== 'island' || !r.fp) continue;
		const w = why.get(r.fp);
		const attr = r.el.getAttribute('data-og-recovered');
		const status: HydrationStatus = w?.status ?? (attr !== null ? 'recovered' : changed.has(r.fp) ? 'changed' : r.hydrated ? 'clean' : 'asleep');
		const s = snaps.get(r.fp);
		rows.push({
			fp: r.fp,
			name: region_name(r.entry),
			wake: r.wake,
			status,
			reason: w?.reason || attr || (r.rides ? `rides ${region_name(r.rides.getAttribute('entry'))}, the island around it (it wakes with it, not on its own)` : ''),
			el: r.el,
			snap: s ? { ssr: s.ssr, hydrated: s.hydrated } : null
		});
	}
	rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name));
	return { rows, measured: !!page };
}

/** The same, as plain data (no elements), with each changed island's diff — for tests. */
export function hydration_report(): { measured: boolean; islands: { fp: string; name: string; wake: string; status: HydrationStatus; reason: string; diff: HtmlDiff | null }[] } {
	const { rows, measured } = hydration_rows();
	return {
		measured,
		islands: rows.map((r) => ({
			fp: r.fp,
			name: r.name,
			wake: r.wake,
			status: r.status,
			reason: r.reason,
			diff: r.snap && r.status !== 'clean' ? html_diff(r.snap.ssr, r.snap.hydrated) : null
		}))
	};
}
