/**
 * What `window.__ogygia_testing` answers (ogygia/playwright calls it through `page.evaluate`). Loaded
 * on the first call, like the dock: plain JSON out (no elements, no WeakRefs), so a test can assert
 * on it and attach it to its report.
 */
import { read_page, unmeasured } from './page.js';
import { hydration_report, hydration_rows } from './hydration.js';
import { start_session, recording, set_last_session, session_names } from './session.js';
import { analyze_session, session_timeline, type Ref } from './session-insights.js';
import { region_name_by_fp } from './regions.js';
import { snapshot } from './bus.js';
import { ensure_region_names } from './names.js';

export async function page_json() {
	await ensure_region_names();
	const v = read_page();
	if (!v) return null;
	return {
		url: location.pathname,
		nav: v.nav,
		vitals: v.report.vitals,
		islands: v.report.rows,
		findings: v.report.findings.map((f) => ({ ...f, names: f.fps.map((fp) => region_name_by_fp(fp)) })),
		blocking: v.report.blocking,
		bytes: v.report.bytes,
		longtask_ms: v.report.longtask_ms,
		cpu: v.cpu ? { busy_ms: v.cpu.busy_ms, by_kind: v.cpu.by_kind, fns: v.cpu.fns.slice(0, 15) } : null,
		cpu_state: v.page.cpu.state,
		cpu_off: v.page.cpu.off ?? null,
		// what this browser cannot measure: a test's "no findings" means less there
		unmeasured: v.unmeasured
	};
}

/** Each island's report, keyed per INSTANCE: the value of `key_attr` on the island or its nearest
 *  ancestor that has it (an id the app renders, e.g. its CMS block's), else `Name#n`, the n-th island
 *  of that name in document order — the same across builds while the page keeps its layout. */
export async function hydration_json(key_attr?: string) {
	await ensure_region_names();
	const report = hydration_report();
	const els = new Map(hydration_rows().rows.map((r) => [r.fp, r.el]));
	const in_order = report.islands
		.map((i) => ({ i, el: els.get(i.fp) }))
		.sort((a, b) => (a.el && b.el && a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1));
	const keys = new Map<string, string>();
	const count = new Map<string, number>();
	for (const { i, el } of in_order) {
		const n = (count.get(i.name) ?? 0) + 1;
		count.set(i.name, n);
		const own = key_attr && el ? el.closest(`[${CSS.escape(key_attr)}]`)?.getAttribute(key_attr) : null;
		keys.set(i.fp, own || `${i.name}#${n}`);
	}
	return { ...report, islands: report.islands.map((i) => ({ ...i, key: keys.get(i.fp)! })) };
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

export async function record_stop(blocked: BlockedNavigation[] = []) {
	const rec = recording();
	if (!rec) return null;
	const data = await rec.stop();
	await ensure_region_names();
	const names = session_names(data, (fp) => region_name_by_fp(fp));
	const report = analyze_session(data, names, location.href);
	// each blocked navigation with the input just before it: what made the page try to leave
	const inputs = [...data.clicks, ...data.interactions].sort((a, b) => a.t - b.t);
	const navigations = blocked.map((n) => {
		const before = n.t === null ? undefined : inputs.filter((x) => x.t <= n.t!).at(-1);
		return { url: n.url, t: n.t, after: before?.target ?? null, island: before?.fp ? names(before.fp) : null };
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
			: ((ref.kind === 'interaction' ? data.interactions : ref.kind === 'click' ? data.clicks : data.shifts)[ref.i]?.fp ?? null);
	let nav_i = 0;
	return {
		...report,
		findings: report.findings.map((f) => {
			const named = f.refs.map(fp_of).filter((fp): fp is string => !!fp).map(names);
			if (f.code === 'navigation-blocked') {
				const island = navigations[nav_i++]?.island;
				if (island) named.push(island);
			}
			return { ...f, names: [...new Set(named)] };
		}),
		navigations,
		timeline: session_timeline(data, names).map((l) => ({ ...l, items: l.items.map(({ ref: _ref, ...it }) => it) })),
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
			if ((e.name === 'region.hydrate.done' || e.name === 'region.hydrate.failed') && e.fp) started.delete(e.fp);
			if (e.name === 'region.hydrate.start' || e.name === 'region.hydrate.done' || e.name === 'wake.fired') last = Math.max(last, e.t);
		}
		if (!started.size && performance.now() - last >= quiet && document.readyState === 'complete') return true;
		if (performance.now() > until) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}
