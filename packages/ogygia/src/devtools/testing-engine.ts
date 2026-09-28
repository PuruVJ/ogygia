/**
 * What `window.__ogygia_testing` answers (ogygia/playwright calls it through `page.evaluate`). Loaded
 * on the first call, like the dock: plain JSON out (no elements, no WeakRefs), so a test can assert
 * on it and attach it to its report.
 */
import { read_page, unmeasured } from './page.js';
import { hydration_report } from './hydration.js';
import { start_session, recording, set_last_session, session_names } from './session.js';
import { analyze_session, session_timeline } from './session-insights.js';
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

export async function hydration_json() {
	await ensure_region_names();
	return hydration_report();
}

export function record_start(): boolean {
	if (recording()) return false;
	start_session();
	return true;
}

export async function record_stop() {
	const rec = recording();
	if (!rec) return null;
	const data = await rec.stop();
	await ensure_region_names();
	const names = session_names(data, (fp) => region_name_by_fp(fp));
	const report = analyze_session(data, names, location.href);
	set_last_session({ data, report });
	window.__ogygia_session = report;
	return {
		...report,
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
