/**
 * The devtools LAUNCHER — the only part of devtools the runtime chunk carries. Called from the runtime
 * boot on a devtools build (behind the `__OGYGIA_DEVTOOLS__` gate: off, all of it tree-shakes away).
 * It makes the shadow host and, in a build, one small plain-DOM button: the dock itself (ui-app.ts,
 * Svelte, every tab, their CSS) loads when someone opens it — a dynamic import the bundler splits
 * off, so a preview deploy with devtools on costs its visitors a button. On the dev server the dock
 * loads at once.
 *
 * The panel mounts on the LIVE page (not an iframe), so its host element carries a **shadow root** for
 * total CSS isolation: host-page globals can't reach in (a stray `.spacer { height: 140vh }` once
 * ballooned the header) and the devtools' own styles can't leak out. The host is attached to
 * `<html>` (not `<body>`) so a full-body SPA swap never tears the panel out.
 *
 * Opening it once sets the `og_devtools` cookie: from the next load on, the server writes its event
 * side-channel and the page is measured from the start (runtime/beacon.ts) — for that browser only.
 */
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;
const LAZY = typeof __OGYGIA_DEVTOOLS_LAZY__ !== 'undefined' ? __OGYGIA_DEVTOOLS_LAZY__ : false;

/** Set when the dock is opened: the server's side-channel and the page measuring follow it. */
export const DEVTOOLS_COOKIE = 'og_devtools';
const LAYOUT_KEY = 'ogygia:devtools:layout:v4';

let mounted = false;

export function install_devtools_ui(opts?: { csr_true?: boolean }): void {
	if (!DEVTOOLS || typeof document === 'undefined' || mounted) return;
	// Never mount on a profiler page — including the Profiler tab's embedded `/run` iframe. Profiler pages
	// tag themselves with `<meta name="ogygia-devtools" content="off">`; the devtools has no business
	// x-raying its own tooling (and a launcher inside the iframe is nonsense).
	if (document.querySelector('meta[name="ogygia-devtools"][content="off"]')) return;
	// ONE dock per document, whichever copy of this module asks: a Kit-hydrated page with holes
	// boots both the standalone dock and the ogygia runtime, and two copies of this module (two
	// URLs for one file) each have their own `mounted` — the host element is the shared truth
	if (document.querySelector('[data-ogygia-devtools-host]')) return;
	mounted = true;
	install_testing_api();
	// a session the page before was recording (a full page load mid-session) goes on here — the
	// recorder loads only then (the key: session.ts SAVED_KEY)
	try {
		if (sessionStorage.getItem('ogygia:devtools:session')) void import('./session.js').then((m) => m.resume_session_if_any());
	} catch {
		// no storage
	}
	// A 0×0 fixed host holds the shadow root; the real UI is a fixed, viewport-filling root inside it.
	// MAX z-index (int32) on the HOST: without one the host stacks at `auto` in the page's root
	// context, so any app overlay with a z-index paints over the dock. At 2147483647 — plus being
	// appended to documentElement AFTER body, which wins the DOM-order tiebreak against equal-z page
	// elements — nothing a page can write out-stacks it. Everything inside the shadow root then only
	// orders against itself.
	const host = document.createElement('div');
	host.setAttribute('data-ogygia-devtools-host', '');
	host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
	document.documentElement.appendChild(host);
	const root = host.attachShadow({ mode: 'open' });
	const csr_true = opts?.csr_true ?? false;

	// The button shows at once; the dock replaces it when its code is in. A click while it loads is
	// remembered (`want_open`), so the dock opens when it arrives.
	let loading = false;
	let want_open = false;
	let button: HTMLButtonElement | null = null;
	let on_key: ((e: KeyboardEvent) => void) | null = null;
	const load = () => {
		if (loading) return;
		loading = true;
		void import('./ui-app.js').then((m) => {
			button?.remove();
			if (on_key) removeEventListener('keydown', on_key);
			m.mount_app(root, { csr_true, start_open: want_open });
		});
	};
	button = document.createElement('button');
	button.setAttribute('data-og-panel-toggle', '');
	button.title = 'ogygia devtools (Alt+O)';
	button.textContent = 'og devtools';
	button.style.cssText =
		'position:fixed;right:24px;bottom:8px;padding:7px 12px;border-radius:999px;border:1px solid rgba(148,163,184,.35);' +
		'background:#0b1220;color:#e2e8f0;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;' +
		'opacity:.55;box-shadow:0 4px 16px rgba(0,0,0,.4)';
	const b = button;
	b.onmouseenter = () => (b.style.opacity = '1');
	b.onmouseleave = () => (b.style.opacity = '.55');
	const open = () => {
		if (LAZY) set_cookie();
		want_open = true;
		b.textContent = 'loading…';
		load();
	};
	b.onclick = open;
	on_key = (e: KeyboardEvent) => {
		if (e.altKey && (e.key === 'o' || e.key === 'O')) {
			e.preventDefault();
			open();
		}
	};
	addEventListener('keydown', on_key);
	root.appendChild(b);
	// a dock left open: its code now (it restores its own state). On the dev server a closed dock
	// still loads, but only once the page is done and the browser idle — the dock's own work must
	// not land in the page load it measures (it once pushed a healthy island's wake a second late)
	if (was_open()) load();
	else if (!LAZY) after_load_idle(load);
}

function after_load_idle(fn: () => void): void {
	const idle = () => {
		const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
		if (ric) ric(fn, { timeout: 3000 });
		else setTimeout(fn, 1000);
	};
	if (document.readyState === 'complete') setTimeout(idle, 500);
	else addEventListener('load', () => setTimeout(idle, 500), { once: true });
}

/**
 * `window.__ogygia_testing` — what ogygia/playwright drives through `page.evaluate`: the page report,
 * each island's hydration, a recorded session, "settled". Tiny here: each call loads the engine
 * (testing-engine.ts) on first use, like the dock. Version-stamped so the fixture can refuse a
 * mismatch.
 */
export interface OgygiaTestingApi {
	version: 1;
	page(): Promise<unknown>;
	hydration(): Promise<unknown>;
	record_start(): Promise<boolean>;
	record_stop(): Promise<unknown>;
	settled(quiet?: number, timeout?: number): Promise<boolean>;
}
declare global {
	interface Window {
		__ogygia_testing?: OgygiaTestingApi;
	}
}
function install_testing_api(): void {
	if (window.__ogygia_testing) return;
	const engine = () => import('./testing-engine.js');
	window.__ogygia_testing = {
		version: 1,
		page: async () => (await engine()).page_json(),
		hydration: async () => (await engine()).hydration_json(),
		record_start: async () => (await engine()).record_start(),
		record_stop: async () => (await engine()).record_stop(),
		settled: async (quiet, timeout) => (await engine()).settled(quiet, timeout)
	};
}

/** Has this browser opened the dock before (from then on the page is measured from the start). */
export function devtools_opted_in(): boolean {
	try {
		return document.cookie.split('; ').some((c) => c === DEVTOOLS_COOKIE + '=1');
	} catch {
		return false;
	}
}

function set_cookie(): void {
	try {
		document.cookie = `${DEVTOOLS_COOKIE}=1; path=/; max-age=2592000; samesite=lax`;
	} catch {
		// cookies off: the dock still works, the page just is not measured from the start
	}
}

function was_open(): boolean {
	try {
		return !!JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')?.open;
	} catch {
		return false;
	}
}
