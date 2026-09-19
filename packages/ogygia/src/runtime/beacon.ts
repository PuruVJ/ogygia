/**
 * THE HYDRATION BEACON — the browser's half of the profiler's Islands table. When the document
 * carries `<meta name="ogygia-profiler-beacon" content="/__profiler/beacon">` (the profiler puts it
 * there for its own logged-in user, never for a visitor), every island that wakes reports how long
 * it took — from the wake trigger to `data-hydrated`, and the module-load part of that — keyed by
 * its server-minted fingerprint, so the report joins it to the island's server-side row.
 *
 * Cost when the tag is absent: one `querySelector` on the first hydration, then a boolean. Samples
 * are batched and sent once, on idle or when the page hides, with `sendBeacon` (a fetch with
 * `keepalive` when that is missing) — never on the hydration path itself.
 */

interface Sample {
	fp: string;
	entry: string;
	ms: number;
	load: number;
}

let target: string | null | undefined;
let queue: Sample[] = [];
let scheduled = false;
let listening = false;

function endpoint(): string | null {
	if (target !== undefined) return target;
	if (typeof document === 'undefined') return (target = null);
	const meta = document.querySelector('meta[name="ogygia-profiler-beacon"]');
	const href = meta?.getAttribute('content') ?? '';
	return (target = href ? href : null);
}

function flush(): void {
	scheduled = false;
	if (!queue.length) return;
	const url = endpoint();
	if (!url) return;
	const body = JSON.stringify({ page: location.pathname, islands: queue.splice(0, 400) });
	try {
		// sendBeacon only takes `text/plain` (etc.) without a preflight; the profiler parses the body
		// as JSON whatever the type
		if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
	} catch {
		// fall through to fetch
	}
	try {
		void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'text/plain' } });
	} catch {
		// nothing to do: the beacon is best-effort
	}
}

function schedule(): void {
	if (scheduled) return;
	scheduled = true;
	if (!listening) {
		listening = true;
		document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
		addEventListener('pagehide', flush);
	}
	const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
	if (idle) idle(flush, { timeout: 2000 });
	else setTimeout(flush, 1500);
}

/**
 * Record one island's hydration. `t0` is when the wake began (before the module load), `t_loaded`
 * when its modules were in hand, `t_done` when `data-hydrated` was set. No-op without the tag.
 */
export function beacon_hydrated(el: Element, t0: number, t_loaded: number, t_done: number): void {
	if (!endpoint()) return;
	const fp = el.getAttribute('data-og-fp');
	if (!fp) return;
	queue.push({
		fp,
		entry: el.getAttribute('entry') ?? '',
		ms: Math.max(0, Math.round((t_done - t0) * 100) / 100),
		load: Math.max(0, Math.round((t_loaded - t0) * 100) / 100)
	});
	schedule();
}

/** @internal tests */
export function _reset_beacon(): void {
	target = undefined;
	queue = [];
	scheduled = false;
}

/** @internal tests */
export function _beacon_state(): { target: string | null | undefined; queued: number; scheduled: boolean } {
	return { target, queued: queue.length, scheduled };
}
