/**
 * Every island's hydration status, from the bus (failed / recovered / healed), the beacon's
 * before-and-after markup (changed), the element (`data-og-recovered`, `data-hydrated`). Shared by
 * the Hydration tab and the testing API (`window.__ogygia_testing.hydration()`).
 */
import { snapshot } from '@ogygia/core/events';
import { beacon_page, type AttrChange } from '@ogygia/core/internal/instruments';
import { all_regions, region_name } from './regions.ts';
import { html_diff, type HtmlDiff } from '@ogygia/core/insights';
import type { HydrationStatus } from '@ogygia/core/insights';

export type { HydrationStatus } from '@ogygia/core/insights';
export const STATUS_RANK: Record<HydrationStatus, number> = {
	failed: 0,
	recovered: 1,
	healed: 2,
	changed: 3,
	asleep: 4,
	clean: 5
};

export interface IslandHydration {
	fp: string;
	name: string;
	wake: string;
	status: HydrationStatus;
	reason: string;
	el: Element;
	/** `from`: a big island keeps only the window around its first change (runtime/beacon.ts
	 *  `snapshot_of`) — where that window starts in its markup without comments */
	snap: { ssr: string; hydrated: string; from?: number } | null;
}

export function hydration_rows(): { rows: IslandHydration[]; measured: boolean } {
	const why = new Map<string, { status: HydrationStatus; reason: string }>();
	for (const e of snapshot()) {
		if (e.name === 'region.hydrate.failed') {
			if (e.fp) why.set(e.fp, { status: 'failed', reason: e.message.split('\n')[0] });
		} else if (e.name === 'region.hydrate.recovered') {
			if (e.fp) why.set(e.fp, { status: 'recovered', reason: e.reason ?? '' });
		} else if (e.name === 'region.hydrate.healed') {
			if (e.fp && why.get(e.fp)?.status !== 'recovered')
				why.set(e.fp, { status: 'healed', reason: e.reason ?? '' });
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
		const status: HydrationStatus =
			w?.status ??
			(attr !== null
				? 'recovered'
				: changed.has(r.fp)
					? 'changed'
					: r.hydrated
						? 'clean'
						: 'asleep');
		const s = snaps.get(r.fp);
		rows.push({
			fp: r.fp,
			name: region_name(r.entry),
			wake: r.wake,
			status,
			reason:
				w?.reason ||
				attr ||
				(r.rides
					? `rides ${region_name(r.rides.getAttribute('entry'))}, the island around it (it wakes with it, not on its own)`
					: ''),
			el: r.el,
			snap: s
				? { ssr: s.ssr, hydrated: s.hydrated, ...(s.from !== undefined ? { from: s.from } : {}) }
				: null
		});
	}
	rows.sort(
		(a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name)
	);
	return { rows, measured: !!page };
}

/** The same, as plain data (no elements), with each changed island's diff — for tests. `t0` / `done`:
 *  when it began to wake and when it could answer, on the document's clock (ms from its start; null
 *  for an island that has not woken), so a test can tell which of its steps woke it. */
export function hydration_report(): {
	measured: boolean;
	islands: {
		fp: string;
		name: string;
		wake: string;
		status: HydrationStatus;
		reason: string;
		diff: HtmlDiff | null;
		t0: number | null;
		done: number | null;
		/** a `changed` island whose only differences are attributes (the same elements and text — often a
		 *  custom element setting its own as it upgrades); false when text or elements differ */
		attributesOnly: boolean;
		/** with `attributesOnly`, each attribute that differs */
		attributes: AttrChange[] | null;
		/** input landed on it while it hydrated (a pointer over it, a press, a key, focus): its DOM may
		 *  have answered that input */
		inputDuringHydration: boolean;
		window_from?: number;
	}[];
} {
	const { rows, measured } = hydration_rows();
	const woke = new Map((beacon_page()?.islands ?? []).map((i) => [i.fp, i]));
	return {
		measured,
		islands: rows.map((r) => ({
			fp: r.fp,
			name: r.name,
			wake: r.wake,
			status: r.status,
			reason: r.reason,
			diff: r.snap && r.status !== 'clean' ? html_diff(r.snap.ssr, r.snap.hydrated) : null,
			t0: woke.get(r.fp)?.t0 ?? null,
			done: woke.get(r.fp)?.done ?? null,
			attributesOnly: r.status === 'changed' && !!woke.get(r.fp)?.attrs,
			attributes: r.status === 'changed' ? (woke.get(r.fp)?.attrs ?? null) : null,
			inputDuringHydration: !!woke.get(r.fp)?.input,
			...(r.snap?.from !== undefined ? { window_from: r.snap.from } : {})
		}))
	};
}
