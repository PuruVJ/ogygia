/**
 * WHAT AN ISLAND LEFT RUNNING AFTER IT LEFT THE PAGE. The router keeps the document across
 * navigations, so an interval an island started, or a listener it put on `window` or `document`, and
 * never took back outlives the island: it keeps running (often on state that is gone), holds the
 * island's closure in memory, and every navigation back to its page adds another one.
 *
 * Dev tool only (installed from the runtime's boot behind the DEVTOOLS gate, before any island
 * wakes): `setInterval` / `clearInterval` and `addEventListener` / `removeEventListener` on `window`
 * and `document` are watched. Every other target passes straight through (one identity check). Each
 * watched registration keeps the first files of its stack; the island whose code made it is decided
 * only when the report asks (`owned_leftovers`, pure). A registration counts as left behind when an
 * instance of its island existed when it was made and none of the instances alive now did: the one
 * that made it is gone, and it is still set.
 *
 * Only the island's own code, one or two calls away, owns a registration: Svelte's own listeners
 * (its event delegation on `document`, set while a component's module evaluates) sit deeper in the
 * stack, and are Svelte's to keep.
 */

export interface LeftoverReg {
	kind: 'interval' | 'listener';
	/** a listener's target and event */
	target?: 'window' | 'document';
	type?: string;
	capture?: boolean;
	/** the files of the first calls above the registration (its caller first) */
	frames: string[];
	/** when it was made (performance.now) */
	t: number;
	/** an interval's runs so far, and the last one */
	fires: number;
	last?: number;
}

/** One island entry as this tab saw it: where its code lives, its instances, when one last left. */
export interface LeftoverIsland {
	entry: string;
	/** its file locations (the entry, and the content-hashed file a build loads) as absolute URLs */
	urls: string[];
	/** when each instance seen alive now started (performance.now) */
	live: number[];
	/** when its first instance started, and when one last left */
	first: number;
	gone?: number;
}

/** What the report says: per island, what it left behind. */
export interface Leftover {
	name: string;
	entry: string;
	intervals: number;
	/** `window 'resize'` … */
	listeners: string[];
	/** the intervals' runs since they were set, and how long ago the last one ran */
	fires: number;
	last_ago?: number;
}

const intervals = new Map<unknown, LeftoverReg>();
const listeners = new Map<unknown, (LeftoverReg & { on: EventTarget })[]>();
const islands = new Map<string, { urls: string[]; first: number; gone?: number; els: Map<Element, number> }>();
let own_file = '';
let installed = false;

/** The file URL of each stack line (Chrome `at f (url:1:2)` / `at url:1:2`, Firefox and Safari
 *  `f@url:1:2`), without its position or query. No regex: this runs on every watched registration. */
export function stack_files(stack: string): string[] {
	const out: string[] = [];
	// (Chrome's first line is the message, with no file: dropped like any line without one)
	let from = 0;
	while (from < stack.length) {
		let end = stack.indexOf('\n', from);
		if (end === -1) end = stack.length;
		let line = stack.slice(from, end).trim();
		from = end + 1;
		if (line.endsWith(')')) {
			const open = line.lastIndexOf('(');
			if (open !== -1) line = line.slice(open + 1, -1);
		} else {
			const at = line.lastIndexOf('@');
			if (at !== -1) line = line.slice(at + 1);
			else if (line.startsWith('at ')) line = line.slice(3);
		}
		// `url:line:col` → `url`
		for (let k = 0; k < 2; k++) {
			const c = line.lastIndexOf(':');
			if (c === -1) break;
			const tail = line.slice(c + 1);
			if (!tail.length || tail.charCodeAt(0) < 48 || tail.charCodeAt(0) > 57) break;
			line = line.slice(0, c);
		}
		const q = line.indexOf('?');
		if (q !== -1) line = line.slice(0, q);
		if (line.includes('://')) out.push(line);
	}
	return out;
}

/** The first `n` files above the watcher (the caller, and its caller). */
function callers(n = 2): string[] {
	const files = stack_files(new Error().stack ?? '');
	const out: string[] = [];
	for (const f of files) {
		if (f === own_file) continue;
		out.push(f);
		if (out.length === n) break;
	}
	return out;
}

// a BUILD with devtools on: only a browser that opened the dock once is watched (its cookie, as the
// beacon's measuring) — every other visitor of a preview deploy keeps the browser's own functions
const DEVTOOLS_LAZY = typeof __OGYGIA_DEVTOOLS_LAZY__ !== 'undefined' ? __OGYGIA_DEVTOOLS_LAZY__ : false;
function opted_in(): boolean {
	try {
		return document.cookie.split('; ').some((c) => c === 'og_devtools=1');
	} catch {
		return false;
	}
}

/** Watch intervals and the global listeners. Once per page; a no-op off the browser. */
export function watch_leftovers(): void {
	if (installed || typeof window === 'undefined' || typeof EventTarget === 'undefined') return;
	if (DEVTOOLS_LAZY && !opted_in()) return;
	installed = true;
	own_file = stack_files(new Error().stack ?? '')[0] ?? '';
	// (typed as the browser has them: the Node timer types merge into `window`'s)
	const set_interval = window.setInterval as unknown as (this: Window, fn: unknown, ms?: number, ...a: unknown[]) => number;
	const clear_interval = window.clearInterval as unknown as (this: Window, id?: unknown) => void;
	window.setInterval = function (this: unknown, fn: unknown, ms?: number, ...args: unknown[]) {
		if (typeof fn !== 'function') return set_interval.call(window, fn, ms, ...args);
		const reg: LeftoverReg = { kind: 'interval', frames: callers(), t: performance.now(), fires: 0 };
		const id = set_interval.call(
			window,
			function (this: unknown, ...a: unknown[]) {
				reg.fires++;
				reg.last = performance.now();
				return (fn as (...a: unknown[]) => unknown).apply(this, a);
			},
			ms,
			...args
		);
		intervals.set(id, reg);
		return id;
	} as unknown as typeof window.setInterval;
	window.clearInterval = function (id?: unknown) {
		intervals.delete(id);
		return clear_interval.call(window, id);
	} as unknown as typeof window.clearInterval;
	const proto = EventTarget.prototype;
	const add = proto.addEventListener;
	const remove = proto.removeEventListener;
	proto.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
		if ((this === window || this === document) && fn) {
			const o = typeof opts === 'object' && opts ? opts : null;
			// (a `once` listener takes itself back; an aborted signal takes it back)
			if (!o?.once && !o?.signal?.aborted) note_listener(this, type, fn, o ? !!o.capture : !!opts, o?.signal);
		}
		if (fn && SCROLL_TYPES.has(type)) note_scroll_listener(this, type, fn, opts);
		return add.call(this, type, fn, opts);
	};
	proto.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
		if ((this === window || this === document) && fn) forget_listener(this, type, fn, typeof opts === 'object' && opts ? !!opts.capture : !!opts);
		if (fn && SCROLL_TYPES.has(type)) forget_scroll_listener(this, type, fn);
		return remove.call(this, type, fn, opts);
	};
}

// ── LISTENERS THAT HOLD SCROLLING: a `wheel` / `touchstart` / `touchmove` listener the browser must
// run before it scrolls (it might call preventDefault). On `window`, `document`, `<html>` and
// `<body>` the browser treats them as passive unless `passive: false` is asked for; anywhere else
// they block unless `passive: true` is ──

const SCROLL_TYPES: ReadonlySet<string> = new Set(['wheel', 'mousewheel', 'touchstart', 'touchmove']);

export interface ScrollReg {
	type: string;
	/** `window`, `document`, or the element briefly (`div.scroller`) */
	on: string;
	/** `passive: false` asked for on purpose */
	forced: boolean;
	frames: string[];
}
const scroll_regs: (ScrollReg & { target: EventTarget; fn: unknown })[] = [];

function note_scroll_listener(on: EventTarget, type: string, fn: unknown, opts?: boolean | AddEventListenerOptions) {
	const passive = typeof opts === 'object' && opts ? opts.passive : undefined;
	const root = on === window || on === document || on === document.documentElement || on === document.body;
	if (passive === true || (root && passive !== false) || scroll_regs.length >= 40) return;
	if (scroll_regs.some((r) => r.target === on && r.type === type && r.fn === fn)) return;
	let desc = on === window ? 'window' : on === document ? 'document' : '';
	if (!desc && on instanceof Element) {
		let cls = '';
		for (const c of on.classList)
			if (!c.startsWith('svelte-')) {
				cls = c;
				break;
			}
		desc = `${on.tagName.toLowerCase()}${on.id ? `#${on.id}` : cls ? `.${cls}` : ''}`;
	}
	// (six files: an `onwheel={…}` attribute is attached by Svelte's code, the island's file deeper;
	// none at all: code the browser injected — an extension, a test driver — not the page's to fix)
	const frames = callers(6);
	if (!frames.length) return;
	scroll_regs.push({ type, on: desc || 'an element', forced: passive === false, frames, target: on, fn });
}

function forget_scroll_listener(on: EventTarget, type: string, fn: unknown) {
	const i = scroll_regs.findIndex((r) => r.target === on && r.type === type && r.fn === fn);
	if (i !== -1) scroll_regs.splice(i, 1);
}

/** The scroll-holding listeners still attached (an element's, while it is in the page). */
export function scroll_listeners(): ScrollReg[] {
	return scroll_regs.filter((r) => !(r.target instanceof Element) || r.target.isConnected).map(({ target: _t, fn: _f, ...r }) => r);
}

/** Each one's owner, the island whose file is the nearest of its callers (as owned_leftovers
 *  decides), else the first caller's file. PURE. */
export function owned_scroll_listeners(regs: ScrollReg[], isls: LeftoverIsland[], name_of: (entry: string) => string): { owner: string; type: string; on: string; forced: boolean }[] {
	const stem = (url: string) => {
		const file = url.slice(url.lastIndexOf('/') + 1);
		const dot = file.indexOf('.');
		return dot === -1 ? file : file.slice(0, dot);
	};
	const named = isls.map((i) => ({ ...i, name: name_of(i.entry) }));
	return regs.map((r) => {
		let owner = '';
		for (const f of r.frames) {
			const hit = named.find((i) => i.urls.includes(f)) ?? (f.endsWith('.svelte') ? named.find((i) => i.name === stem(f)) : undefined);
			if (hit) {
				owner = hit.name;
				break;
			}
		}
		if (!owner) {
			const f = r.frames[0] ?? '';
			owner = f ? f.slice(f.lastIndexOf('/') + 1) : 'a script';
		}
		return { owner, type: r.type, on: r.on, forced: r.forced };
	});
}

function note_listener(on: EventTarget, type: string, fn: unknown, capture: boolean, signal?: AbortSignal) {
	const list = listeners.get(fn) ?? [];
	// (the same listener twice is one listener, as the browser counts it)
	if (list.some((r) => r.on === on && r.type === type && r.capture === capture)) return;
	const frames = callers();
	list.push({ kind: 'listener', on, target: on === window ? 'window' : 'document', type, capture, frames, t: performance.now(), fires: 0 });
	listeners.set(fn, list);
	signal?.addEventListener('abort', () => forget_listener(on, type, fn, capture), { once: true });
}

function forget_listener(on: EventTarget, type: string, fn: unknown, capture: boolean) {
	const list = listeners.get(fn);
	if (!list) return;
	const i = list.findIndex((r) => r.on === on && r.type === type && r.capture === capture);
	if (i !== -1) list.splice(i, 1);
	if (!list.length) listeners.delete(fn);
}

/** An island instance starts (its hydrate begins): `entry` and its file locations. */
export function leftover_island_seen(el: Element, entry: string, urls: string[]): void {
	let isl = islands.get(entry);
	if (!isl) islands.set(entry, (isl = { urls, first: performance.now(), els: new Map() }));
	for (const u of urls) if (!isl.urls.includes(u)) isl.urls.push(u);
	if (!isl.els.has(el)) isl.els.set(el, performance.now());
}

/** An island instance left the page (its region disconnected and its app was disposed). */
export function leftover_island_gone(el: Element, entry: string): void {
	const isl = islands.get(entry);
	if (!isl || !isl.els.delete(el)) return;
	isl.gone = performance.now();
}

/** Everything watched, as it stands now (for `owned_leftovers`). */
export function leftover_state(): { regs: LeftoverReg[]; islands: LeftoverIsland[] } {
	const regs: LeftoverReg[] = [...intervals.values()];
	for (const list of listeners.values()) for (const { on: _, ...r } of list) regs.push(r);
	const out: LeftoverIsland[] = [];
	for (const [entry, isl] of islands) {
		const live: number[] = [];
		for (const [el, t] of isl.els) if (el.isConnected) live.push(t);
		out.push({ entry, urls: isl.urls, live, first: isl.first, ...(isl.gone !== undefined ? { gone: isl.gone } : {}) });
	}
	return { regs, islands: out };
}

/**
 * Per island, what it left behind (PURE). A registration's owner is the island whose file is one of
 * its first two callers: by location (a build's file, the entry), else by name (dev serves the
 * component's own `.svelte` file, named as the island is). Left behind: an instance of that island
 * was alive before it was made, and every instance alive now started after it.
 */
export function owned_leftovers(regs: LeftoverReg[], isls: LeftoverIsland[], name_of: (entry: string) => string, now: number): Leftover[] {
	const named = isls.map((i) => ({ ...i, name: name_of(i.entry) }));
	const stem = (url: string) => {
		const file = url.slice(url.lastIndexOf('/') + 1);
		const dot = file.indexOf('.');
		return dot === -1 ? file : file.slice(0, dot);
	};
	const by_name = new Map<string, Leftover>();
	for (const r of regs) {
		let owners: typeof named = [];
		for (const f of r.frames) {
			owners = named.filter((i) => i.urls.includes(f));
			if (!owners.length && f.endsWith('.svelte')) owners = named.filter((i) => i.name === stem(f));
			if (owners.length) break;
		}
		if (!owners.length) continue;
		// made while an instance was alive, and no instance alive now was there to make it
		if (!owners.some((i) => i.first <= r.t) || owners.some((i) => i.live.some((t) => t <= r.t))) continue;
		if (!owners.some((i) => i.gone !== undefined && i.gone >= r.t)) continue;
		const name = owners[0].name;
		const l = by_name.get(name) ?? { name, entry: owners[0].entry, intervals: 0, listeners: [], fires: 0 };
		if (r.kind === 'interval') {
			l.intervals++;
			l.fires += r.fires;
			if (r.last !== undefined) l.last_ago = Math.min(l.last_ago ?? Infinity, Math.round(now - r.last));
		} else l.listeners.push(`${r.target} '${r.type}'`);
		by_name.set(name, l);
	}
	return [...by_name.values()];
}
