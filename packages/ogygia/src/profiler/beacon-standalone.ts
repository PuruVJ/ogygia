/**
 * THE BEACON FOR A PAGE WITHOUT THE OGYGIA RUNTIME — a Kit-hydrated (`csr = true`) page, or any
 * page with no island. The runtime's beacon (runtime/beacon.ts) lives in the runtime, so without
 * this such a page would never report its vitals, long tasks or CPU — and the page score would
 * measure it on less than an islands page (the unfairness the score rework removed).
 *
 * An inline script the profiler adds for ITS OWN user only (next to the beacon meta tag; never a
 * visitor), made with ogygia's own `script()`: `standalone_beacon` is inlined through
 * `Function.prototype.toString`, so it is SELF-CONTAINED — browser globals only, every helper inside
 * it. It steps aside at once when the ogygia runtime's script is already in the head (the usual
 * order), else watches and checks again at DOMContentLoaded. It must never hold the JS sampler the
 * runtime's beacon needs: the browser runs one at a time. Same payloads as the runtime's:
 * `{page, vitals}`, `{page, visit}` (no islands), `{page, cpu}`. No regex. Like the runtime's, a later
 * largest paint, a shift or a worse interaction re-sends the visit (debounced, at most 8 times): the
 * hide-time message is the one most often lost.
 */
import { script } from '../script.js';

/** The beacon itself. Runs in the browser, as an inline classic script. */
export function standalone_beacon(): void {
	type Timed = PerformanceEntry & { value?: number; hadRecentInput?: boolean; interactionId?: number; url?: string; element?: Element | null };
	type Visit = Record<string, unknown>;
	interface SelfProfiler {
		stop(): Promise<unknown>;
	}
	const w = window as Window & { __og_beacon_standalone?: number; Profiler?: new (o: { sampleInterval: number; maxBufferSize: number }) => SelfProfiler };
	if (w.__og_beacon_standalone) return;
	w.__og_beacon_standalone = 1;
	const url = document.querySelector('meta[name="ogygia-profiler-beacon"]')?.getAttribute('content');
	if (!url || typeof PerformanceObserver === 'undefined') return;
	// the runtime is on the page: its beacon reports, this one never starts
	if (document.querySelector('script[data-ogygia-runtime]')) return;

	const r2 = (n: number) => Math.round(n * 100) / 100;
	const vitals: Record<string, number> = {};
	const paints: { fcp?: number; lcp?: number; lcp_url?: string; lcp_tag?: string; lcp_lazy?: true } = {};
	const shifts: { t: number; value: number }[] = [];
	const longtasks: { t: number; ms: number }[] = [];
	const observers: PerformanceObserver[] = [];
	/** every resource entry (the observer sees past the browser's buffer) */
	const seen: PerformanceResourceTiming[] = [];
	let off = false;
	let cls = 0;
	let sent = false;
	let resend: ReturnType<typeof setTimeout> | undefined;
	/** visits sent while the page lives (the early one, then re-sends): at most 8 */
	let early_sends = 0;
	let profiler: SelfProfiler | null = null;

	const watch = (type: string, on: (entries: Timed[]) => void) => {
		try {
			const po = new PerformanceObserver((list) => {
				if (!off) on(list.getEntries() as Timed[]);
			});
			po.observe(type === 'event' ? ({ type, buffered: true, durationThreshold: 16 } as PerformanceObserverInit) : { type, buffered: true });
			observers.push(po);
		} catch {
			/* an entry type this browser does not have */
		}
	};

	try {
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		if (nav && nav.responseStart > 0) vitals.ttfb = r2(nav.responseStart);
	} catch {
		/* no navigation timing */
	}
	watch('paint', (es) => {
		for (const e of es) if (e.name === 'first-contentful-paint') vitals.fcp = paints.fcp = r2(e.startTime);
	});
	watch('largest-contentful-paint', (es) => {
		const e = es[es.length - 1];
		if (!e) return;
		vitals.lcp = paints.lcp = r2(e.startTime);
		paints.lcp_url = e.url || undefined;
		paints.lcp_tag = e.element?.tagName ? e.element.tagName.toLowerCase() : undefined;
		paints.lcp_lazy = e.element?.getAttribute?.('loading') === 'lazy' ? true : undefined;
		again();
	});
	try {
		if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) vitals.cls = 0;
	} catch {
		/* no entry-type list */
	}
	watch('layout-shift', (es) => {
		for (const e of es) {
			if (e.hadRecentInput || typeof e.value !== 'number') continue;
			cls += e.value;
			if (shifts.length < 60) shifts.push({ t: r2(e.startTime), value: Math.round(e.value * 1e4) / 1e4 });
		}
		vitals.cls = Math.round(cls * 1e3) / 1e3;
		again();
	});
	watch('event', (es) => {
		for (const e of es) {
			if (!e.interactionId) continue;
			const d = r2(e.duration);
			if (vitals.inp === undefined || d > vitals.inp) {
				vitals.inp = d;
				clearTimeout(resend);
				resend = setTimeout(early, 1500);
			}
		}
	});
	try {
		performance.setResourceTimingBufferSize(3000);
	} catch {
		/* unsupported */
	}
	watch('resource', (es) => {
		for (const e of es) if (seen.length < 3000) seen.push(e as unknown as PerformanceResourceTiming);
	});
	watch('longtask', (es) => {
		for (const e of es) if (longtasks.length < 100) longtasks.push({ t: r2(e.startTime), ms: r2(e.duration) });
	});
	// the main thread, sampled for the load (JS Self-Profiling, where the document allows it)
	try {
		if (w.Profiler) {
			profiler = new w.Profiler({ sampleInterval: 10, maxBufferSize: 30000 });
			setTimeout(() => cpu(false), 8000);
		}
	} catch {
		profiler = null;
	}

	function post(body: string, keepalive: boolean) {
		try {
			fetch(url!, { method: 'POST', body, keepalive, credentials: 'same-origin', headers: { 'content-type': 'text/plain' } }).catch(() => {});
		} catch {
			/* no fetch */
		}
	}
	/** a beacon when it fits (64 KB, keepalive's cap); a big body as a plain POST while the page lives,
	 *  else its slim form (`slim`), else nothing */
	function send(body: string, slim?: () => string) {
		if (body.length > 60000) {
			if (document.visibilityState === 'visible') return post(body, false);
			const smaller = slim?.();
			if (!smaller || smaller.length > 60000) return;
			body = smaller;
		}
		try {
			if (navigator.sendBeacon?.(url!, body)) return;
		} catch {
			/* no beacon */
		}
		post(body, true);
	}

	/** a URL's extension, lowercased (`''` for none), with no regex */
	function ext(name: string): string {
		const q = name.indexOf('?');
		const path = q < 0 ? name : name.slice(0, q);
		const dot = path.lastIndexOf('.');
		return dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
	}

	/** what each <link> fetched as (a preload's `as`, a modulepreload's script), and its crossorigin;
	 *  read once per visit */
	let link_as: Record<string, string> | null = null;
	let link_co: Record<string, string | null> = {};
	function links(): Record<string, string> {
		if (link_as) return link_as;
		link_as = {};
		link_co = {};
		try {
			for (const l of document.querySelectorAll<HTMLLinkElement>('link[href][as],link[rel="modulepreload"][href]')) {
				link_as[l.href] = l.getAttribute('as') || 'script';
				link_co[l.href] = l.getAttribute('crossorigin');
			}
		} catch {
			/* no document */
		}
		return link_as;
	}

	const LINK_AS: Record<string, string> = { style: 'css', script: 'script', font: 'font', image: 'img', fetch: 'fetch' };
	/** a resource's type, the way the runtime's beacon types it */
	function kind(r: PerformanceResourceTiming): string {
		const x = ext(r.name);
		const by = r.initiatorType;
		if (x === 'woff' || x === 'woff2' || x === 'ttf' || x === 'otf') return 'font';
		if (x === 'css') return 'css';
		if (x === 'js' || x === 'mjs') return 'script';
		if (x === 'png' || x === 'jpg' || x === 'jpeg' || x === 'gif' || x === 'webp' || x === 'avif' || x === 'svg') return 'img';
		if (by === 'link') {
			const as = links()[r.name];
			return as ? LINK_AS[as] || 'other' : 'css';
		}
		if (by === 'css' || by === 'script' || by === 'img') return by;
		if (by === 'fetch' || by === 'xmlhttprequest' || by === 'beacon') return 'fetch';
		return 'other';
	}

	/** PRELOADED, THEN DOWNLOADED AGAIN: one URL fetched by a preload link and again by something
	 *  else, its body over the network the second time (the preload's crossorigin or credentials did
	 *  not match). The runtime's beacon makes the same list. */
	function preload_misses(all: readonly PerformanceResourceTiming[]) {
		const out: { url: string; type: string; bytes: number; as: string; crossorigin: string | null }[] = [];
		try {
			const as = links();
			const by_url = new Map<string, PerformanceResourceTiming[]>();
			for (const r of all) if (!r.name.includes('/__profiler/')) (by_url.get(r.name) ?? by_url.set(r.name, []).get(r.name)!).push(r);
			for (const [u, list] of by_url) {
				if (list.length < 2 || out.length >= 20) continue;
				const pre = list.find((r) => r.initiatorType === 'link');
				if (!pre) continue;
				const again = list.find((r) => r !== pre && r.initiatorType !== 'link' && r.encodedBodySize > 0 && r.transferSize >= r.encodedBodySize);
				if (again) out.push({ url: u.slice(0, 500), type: kind(pre), bytes: again.transferSize, as: as[u] || '', crossorigin: typeof link_co[u] === 'string' ? link_co[u] : null });
			}
		} catch {
			/* no resource timing */
		}
		return out;
	}

	/** the visit as one object (the runtime's shape, with no islands) */
	function visit(): Visit | null {
		link_as = null;
		let nav: PerformanceNavigationTiming | undefined;
		try {
			nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		} catch {
			/* no navigation timing */
		}
		if (!nav || !(nav.responseStart > 0)) return null;
		const resources: Record<string, unknown>[] = [];
		const totals: Record<string, { type: string; count: number; transfer: number; size: number }> = {};
		let count = 0;
		const all = seen.length ? seen : (performance.getEntriesByType('resource') as PerformanceResourceTiming[]);
		try {
			for (const r of all) {
				if (r.name.includes('/__profiler/')) continue;
				count++;
				const type = kind(r);
				const t = (totals[type] ??= { type, count: 0, transfer: 0, size: 0 });
				t.count++;
				t.transfer += r.transferSize || 0;
				t.size += r.decodedBodySize || 0;
			}
			for (const r of all) {
				if (resources.length >= 200) break;
				if (r.name.includes('/__profiler/')) continue;
				const o: Record<string, unknown> = { url: r.name.slice(0, 500), type: kind(r), start: r2(r.startTime), end: r2(r.responseEnd || r.startTime + r.duration) };
				if (r.requestStart) o.req_start = r2(r.requestStart);
				if (r.responseStart) o.res_start = r2(r.responseStart);
				if (r.transferSize) o.transfer = r.transferSize;
				if (r.decodedBodySize) o.size = r.decodedBodySize;
				if ((r as PerformanceResourceTiming & { renderBlockingStatus?: string }).renderBlockingStatus === 'blocking') o.blocking = true;
				resources.push(o);
			}
		} catch {
			/* no resource timing */
		}
		const n: Record<string, unknown> = { req_start: r2(nav.requestStart), res_start: r2(nav.responseStart), res_end: r2(nav.responseEnd) };
		if (nav.domInteractive) n.dom_interactive = r2(nav.domInteractive);
		if (nav.domContentLoadedEventEnd) n.dcl = r2(nav.domContentLoadedEventEnd);
		if (nav.loadEventEnd) n.load = r2(nav.loadEventEnd);
		if (nav.transferSize) n.transfer = nav.transferSize;
		if (nav.decodedBodySize) n.size = nav.decodedBodySize;
		if (nav.nextHopProtocol) n.protocol = nav.nextHopProtocol;
		const out: Visit = { at: Math.round(performance.timeOrigin), nav: n, paints, resources, longtasks, islands: [], firsts: [], shifts, viewport: [innerWidth, innerHeight], ua: navigator.userAgent.slice(0, 200) };
		if (count > resources.length) {
			out.resource_totals = Object.values(totals);
			out.resources_all = count;
		}
		const misses = preload_misses(all);
		if (misses.length) out.preload_misses = misses;
		out.origin = location.origin;
		try {
			const types = PerformanceObserver.supportedEntryTypes || [];
			const missing = ['layout-shift', 'longtask', 'event', 'largest-contentful-paint', 'long-animation-frame'].filter((t) => !types.includes(t));
			if (missing.length) out.unsupported = missing;
		} catch {
			/* no entry-type list */
		}
		if (Object.keys(vitals).length) out.vitals = { ...vitals };
		return out;
	}

	/** the load's CPU trace: once, after 8 s, or as the page hides (only when it fits a beacon) */
	function cpu(hiding: boolean) {
		if (!profiler) return;
		const p = profiler;
		profiler = null;
		p.stop().then(
			(trace) => {
				if (off || !trace) return;
				const body = JSON.stringify({ page: location.pathname, cpu: trace });
				if (hiding && body.length > 60000) return;
				post(body, hiding);
			},
			() => {}
		);
	}

	/** the page is going away: the vitals (final only now), the visit, the CPU trace */
	function hide() {
		if (off || sent) return;
		sent = true;
		if (Object.keys(vitals).length) send(JSON.stringify({ page: location.pathname, at: Math.round(performance.timeOrigin), vitals }));
		const v = visit();
		if (v) send(JSON.stringify({ page: location.pathname, visit: v }), () => JSON.stringify({ page: location.pathname, visit: { ...v, resources: [] } }));
		cpu(true);
	}
	/** a later paint or shift: the visit again a moment later (debounced), once one has gone */
	function again() {
		if (!early_sends || early_sends >= 8) return;
		clearTimeout(resend);
		resend = setTimeout(early, 1500);
	}
	/** the visit while the page lives: the early one, and each re-send */
	function early() {
		if (off || early_sends >= 8) return;
		early_sends++;
		const v = visit();
		if (v) send(JSON.stringify({ page: location.pathname, visit: v }));
	}

	document.addEventListener('DOMContentLoaded', () => {
		// the runtime's script came after this one: it reports — hand back the observers and the sampler
		if (document.querySelector('script[data-ogygia-runtime]')) {
			off = true;
			for (const o of observers) {
				try {
					o.disconnect();
				} catch {
					/* gone */
				}
			}
			if (profiler) {
				try {
					void profiler.stop();
				} catch {
					/* gone */
				}
				profiler = null;
			}
			return;
		}
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') hide();
		});
		addEventListener('pagehide', hide);
		addEventListener('load', () => setTimeout(early, 1500));
	});
}

/** The inline tag the profiler puts in its own user's document, beside the beacon meta tag. */
export const BEACON_STANDALONE_TAG = script({ run: standalone_beacon, 'data-ogygia-beacon': true });
