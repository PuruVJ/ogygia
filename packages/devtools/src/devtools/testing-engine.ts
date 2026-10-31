/**
 * What `window.__ogygia_testing` answers (ogygia/playwright calls it through `page.evaluate`). Loaded
 * on the first call, like the dock: plain JSON out (no elements, no WeakRefs), so a test can assert
 * on it and attach it to its report.
 */
import { read_page, unmeasured, type PageView } from './page.ts';
import { hydration_report, hydration_rows } from './hydration.ts';
import { start_session, recording, set_last_session, session_names } from './session.ts';
import {
	analyze_session,
	session_timeline,
	type Ref,
	type SessionFinding,
	type SessionReport,
	type TimelineItem,
	type TimelineLane
} from '@ogygia/core/insights';
import { region_name_by_fp } from './regions.ts';
import { snapshot } from '@ogygia/core/events';
import { ensure_region_names } from './names.ts';
import { TESTING_ENGINE_VERSION } from '@ogygia/core/insights';
import { nearest_attr } from '@ogygia/core/internal/instruments';
import { charge, own_cost } from '@ogygia/core/internal/instruments';
import { apply_attr_rules, type AttrRule } from '@ogygia/core/insights';
import { testing_lean } from '@ogygia/core/insights';
import type { PageFinding, PageReport } from '@ogygia/core/insights';
import type { CpuSummary } from '@ogygia/core/insights';
import type { BeaconPage, AttrChange } from '@ogygia/core/internal/instruments';

type EngineStamp = { version: number; lean: boolean };
type HydrationIsland = ReturnType<typeof hydration_report>['islands'][number];

/** Which engine answered, and whether in lean testing (switch.ts): on every report. */
const engine = () => ({ version: TESTING_ENGINE_VERSION, lean: testing_lean() });

/** The decoded size of the engine's own files: what the page fetched while its import ran (ui.ts). */
let engine_bytes = 0;
export function note_engine_files(from: number, to: number): void {
	for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[])
		if (
			r.startTime >= from &&
			r.startTime <= to &&
			(r.initiatorType === 'script' || r.initiatorType === 'link' || r.initiatorType === 'other')
		)
			engine_bytes += r.decodedBodySize || 0;
}

/** What ogygia's measuring cost this page, for a test to subtract: the main-thread time of its own work
 *  (checking islands as they hydrate, building the visit, the testing reports — runtime/own-cost.ts)
 *  and the decoded bytes of the testing engine's files. No visitor with devtools off pays either. */
function self_cost(): { script_ms: number; bytes: number; phases: Record<string, number> } {
	const c = own_cost();
	return { script_ms: c.ms, bytes: engine_bytes, phases: c.phases };
}

export async function page_json(cpu_fns = 15): Promise<{
	url: string;
	route: string | null;
	nav: PageView['nav'];
	vitals: PageReport['vitals'];
	islands: PageReport['rows'];
	findings: (PageFinding & { names: string[] })[];
	blocking: PageReport['blocking'];
	bytes: PageReport['bytes'];
	longtask_ms: number;
	cpu: Pick<CpuSummary, 'busy_ms' | 'by_kind' | 'fns'> | null;
	cpu_state: BeaconPage['cpu']['state'];
	cpu_off: string | null;
	unmeasured: string[];
	self: ReturnType<typeof self_cost>;
	engine: EngineStamp;
} | null> {
	await ensure_region_names();
	const c0 = performance.now();
	const v = read_page();
	charge('report', c0);
	if (!v) return null;
	// the route the server rendered (its `og-route` Server-Timing on this document), else null
	let route: string | null = null;
	try {
		const nav = performance.getEntriesByType('navigation')[0] as
			| PerformanceNavigationTiming
			| undefined;
		route = nav?.serverTiming?.find((s) => s.name === 'og-route')?.description || null;
	} catch {
		route = null;
	}
	return {
		url: location.pathname,
		route,
		nav: v.nav,
		vitals: v.report.vitals,
		islands: v.report.rows,
		findings: v.report.findings.map((f) => ({
			...f,
			names: f.fps.map((fp) => region_name_by_fp(fp))
		})),
		blocking: v.report.blocking,
		bytes: v.report.bytes,
		longtask_ms: v.report.longtask_ms,
		cpu: v.cpu
			? {
					busy_ms: v.cpu.busy_ms,
					by_kind: v.cpu.by_kind,
					fns: v.cpu.fns.slice(0, Math.max(1, Math.min(500, cpu_fns)))
				}
			: null,
		cpu_state: v.page.cpu.state,
		cpu_off: v.page.cpu.off ?? null,
		// what this browser cannot measure: a test's "no findings" means less there
		unmeasured: v.unmeasured,
		self: self_cost(),
		engine: engine()
	};
}

/** Each island's report, keyed per INSTANCE: the value of `key_attr` on the island or its NEAREST
 *  ancestor that has it, across shadow roots (an id the app renders, e.g. its CMS block's), else
 *  `Name#n`, the n-th island of that name in document order. Two islands under the same keyed
 *  element are told apart as `key`, `key#2`, … in document order. */
export async function hydration_json(
	key_attr?: string,
	ignore: AttrRule[] = []
): Promise<{
	measured: boolean;
	engine: EngineStamp;
	islands: ((
		| HydrationIsland
		| (Omit<HydrationIsland, 'attributes'> & { attributes: AttrChange[]; ignored: AttrChange[] })
		| (Omit<HydrationIsland, 'status' | 'attributesOnly' | 'attributes' | 'diff'> & {
				status: 'clean';
				attributesOnly: boolean;
				attributes: null;
				diff: null;
				ignored: AttrChange[];
		  })
	) & { key: string })[];
}> {
	await ensure_region_names();
	const base = hydration_report();
	// attribute changes a test ignores: an island whose every difference is one reads `clean`
	const report = {
		...base,
		islands: base.islands.map((i) => {
			if (!i.attributesOnly || !ignore.length || !i.attributes) return i;
			const { left, ignored } = apply_attr_rules(i.attributes, ignore);
			if (!ignored.length) return i;
			return left.length
				? { ...i, attributes: left, ignored }
				: {
						...i,
						status: 'clean' as const,
						attributesOnly: false,
						attributes: null,
						diff: null,
						ignored
					};
		})
	};
	const els = new Map(hydration_rows().rows.map((r) => [r.fp, r.el]));
	const in_order = report.islands
		.map((i) => ({ i, el: els.get(i.fp) }))
		.sort((a, b) =>
			a.el && b.el && a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1
		);
	const keys = new Map<string, string>();
	const count = new Map<string, number>();
	const used = new Map<string, number>();
	for (const { i, el } of in_order) {
		const n = (count.get(i.name) ?? 0) + 1;
		count.set(i.name, n);
		const own = key_attr && el ? nearest_attr(el, key_attr) : null;
		if (own) {
			const k = (used.get(own) ?? 0) + 1;
			used.set(own, k);
			keys.set(i.fp, k === 1 ? own : `${own}#${k}`);
		} else keys.set(i.fp, `${i.name}#${n}`);
	}
	return {
		...report,
		engine: engine(),
		islands: report.islands.map((i) => ({ ...i, key: keys.get(i.fp)! }))
	};
}

export function record_start(): boolean {
	if (recording()) return false;
	start_session();
	return true;
}

/** A navigation the test's driver blocked during the recording: where it went, when (page clock). */
export interface BlockedNavigation {
	url: string;
	t: number | null;
}

export async function record_stop(blocked: BlockedNavigation[] = []): Promise<
	| (Omit<SessionReport, 'findings'> & {
			findings: (SessionFinding & { names: string[] })[];
			navigations: {
				url: string;
				t: number | null;
				after: string | null;
				island: string | null;
				approx: boolean;
			}[];
			engine: EngineStamp;
			timeline: (Omit<TimelineLane, 'items'> & { items: Omit<TimelineItem, 'ref'>[] })[];
			unmeasured: string[];
	  })
	| null
> {
	const rec = recording();
	if (!rec) return null;
	const data = await rec.stop();
	await ensure_region_names();
	const names = session_names(data, (fp) => region_name_by_fp(fp));
	const report = analyze_session(data, names, location.href);
	// each blocked navigation with what started it: the navigation the page saw start for that URL
	// (its link or form, or the input being handled then — exact), else, where the browser has no
	// Navigation API, the last input before it (`approx`)
	const inputs = [...data.clicks, ...data.interactions].sort((a, b) => a.t - b.t);
	const seen = [...(data.navs ?? [])];
	const navigations = blocked.map((n) => {
		let best = -1;
		for (let k = 0; k < seen.length; k++) {
			if (seen[k].url !== n.url) continue;
			if (best === -1 || (n.t !== null && Math.abs(seen[k].t - n.t) < Math.abs(seen[best].t - n.t)))
				best = k;
		}
		if (best !== -1) {
			const [nav] = seen.splice(best, 1);
			return {
				url: n.url,
				t: nav.t,
				after: nav.source,
				island: nav.fp ? names(nav.fp) : null,
				approx: false
			};
		}
		const before = n.t === null ? undefined : inputs.filter((x) => x.t <= n.t!).at(-1);
		return {
			url: n.url,
			t: n.t,
			after: before?.target ?? null,
			island: before?.fp ? names(before.fp) : null,
			approx: true
		};
	});
	for (const n of navigations)
		report.findings.push({
			code: 'navigation-blocked',
			severity: 'warn',
			message: `The page tried to load another document (${n.url})${n.after ? ` after ${n.after}${n.island ? ` in ${n.island}` : ''}` : ''}; it was blocked, so the recording kept going.`,
			fix: 'If that input should keep the page, find what navigates: a link, a form, or a reload in a handler.',
			refs: []
		});
	set_last_session({ data, report });
	window.__ogygia_session = report;
	// each finding with the islands it points at, by name, as page findings carry them
	const fp_of = (ref: Ref): string | null =>
		ref.kind === 'island'
			? ref.fp
			: ((ref.kind === 'interaction'
					? data.interactions
					: ref.kind === 'click'
						? data.clicks
						: data.shifts)[ref.i]?.fp ?? null);
	let nav_i = 0;
	return {
		...report,
		findings: report.findings.map((f) => {
			const named = f.refs
				.map(fp_of)
				.filter((fp): fp is string => !!fp)
				.map(names);
			if (f.code === 'navigation-blocked') {
				const island = navigations[nav_i++]?.island;
				if (island) named.push(island);
			}
			return { ...f, names: [...new Set(named)] };
		}),
		navigations,
		engine: engine(),
		timeline: session_timeline(data, names).map((l) => ({
			...l,
			items: l.items.map(({ ref: _ref, ...it }) => it)
		})),
		unmeasured: unmeasured(data.cpu_off)
	};
}

/** Resolves when no island is mid-hydration and nothing woke for `quiet` ms (or `timeout` passed). */
export async function settled(quiet = 300, timeout = 10_000): Promise<boolean> {
	const until = performance.now() + timeout;
	for (;;) {
		const ev = snapshot();
		const started = new Set<string>();
		let last = 0;
		for (const e of ev) {
			if (e.realm !== 'client') continue;
			if (e.name === 'region.hydrate.start' && e.fp) started.add(e.fp);
			if ((e.name === 'region.hydrate.done' || e.name === 'region.hydrate.failed') && e.fp)
				started.delete(e.fp);
			if (
				e.name === 'region.hydrate.start' ||
				e.name === 'region.hydrate.done' ||
				e.name === 'wake.fired'
			)
				last = Math.max(last, e.t);
		}
		if (!started.size && performance.now() - last >= quiet && document.readyState === 'complete')
			return true;
		if (performance.now() > until) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}
