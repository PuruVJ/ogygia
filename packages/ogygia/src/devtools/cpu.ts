/**
 * The main thread, from the browser's own sampler (the JS Self-Profiling API; runtime/beacon.ts keeps
 * the trace in the page on a devtools build). Pure: a trace + the islands' hydrate windows in, out:
 * busy time by kind of code (the app, ogygia, Svelte, packages, a page script, the browser itself),
 * the functions and files that ran, the CPU inside each island's hydrate window and what it was,
 * and what ran in long tasks outside any island. The Page tab shows it; the findings quote it.
 *
 * The trace's timestamps share `performance.now()`'s clock, so the windows line up with the
 * beacon's island timings without conversion.
 */

export interface SelfProfileTrace {
	frames: { name?: string; resourceId?: number; line?: number; column?: number }[];
	resources: string[];
	samples: { timestamp: number; stackId?: number }[];
	stacks: { frameId: number; parentId?: number }[];
}

export type CodeKind = 'app' | 'ogygia' | 'svelte' | 'dependency' | 'page script' | 'browser' | 'devtools';

export interface CpuFn {
	name: string;
	file: string;
	line: number | null;
	kind: CodeKind;
	self_ms: number;
	total_ms: number;
}

export interface CpuSummary {
	/** sampled span (first to last sample) */
	window_ms: number;
	busy_ms: number;
	by_kind: { kind: CodeKind; ms: number }[];
	fns: CpuFn[];
	files: { file: string; kind: CodeKind; ms: number }[];
	/** per island fingerprint: CPU inside its hydrate window and the functions that took it */
	islands: Record<string, { ms: number; top: CpuFn[] }>;
	/** long tasks outside every island's hydrate window */
	outside: { ms: number; top: CpuFn[] };
	/** the sampling interval seen (ms) */
	interval_ms: number;
	/** main-thread ms per other origin (the nearest frame with a script URL decides) */
	by_host?: Record<string, number>;
}

export interface IslandWindow {
	fp: string;
	from: number;
	to: number;
}

/** A frame's script, readable: origin, Vite's `/@fs` / `/@id/` prefixes and `?v=` queries off. */
export function clean_file(url: string, page_origin = ''): string {
	let u = url;
	if (page_origin && u.startsWith(page_origin)) u = u.slice(page_origin.length);
	const q = u.indexOf('?');
	if (q !== -1) u = u.slice(0, q);
	if (u.startsWith('/@fs')) u = u.slice(4);
	if (u.startsWith('/@id/')) u = u.slice(5);
	if (u.startsWith('__x00__')) u = u.slice(7);
	// a workspace path: from the package or src folder on
	for (const mark of ['/node_modules/.vite/deps/', '/node_modules/', '/packages/', '/src/']) {
		const at = u.lastIndexOf(mark);
		if (at !== -1) return mark === '/src/' ? u.slice(at + 1) : u.slice(at + (mark === '/packages/' ? 10 : mark.length));
	}
	return u;
}

/** What kind of code a frame is, from its script URL (and name, for the browser's own). */
export function kind_of(url: string, page_url: string): CodeKind {
	if (!url) return 'browser';
	const path = url.split('?')[0];
	if (page_url && path === page_url.split('?')[0].split('#')[0]) return 'page script';
	if (path.includes('/.vite/deps/')) {
		const file = path.slice(path.lastIndexOf('/') + 1);
		return file.startsWith('svelte') ? 'svelte' : 'dependency';
	}
	if (path.includes('/svelte/src/') || path.includes('/node_modules/svelte/')) return 'svelte';
	// the measuring itself: the dock and the sampler's own start (kept apart, never a top function)
	if (path.includes('/ogygia/src/devtools/') || path.includes('/ogygia/dist/devtools/') || path.endsWith('/runtime/beacon.ts') || path.endsWith('/runtime/beacon.js')) return 'devtools';
	if (path.includes('/packages/ogygia/') || path.includes('/node_modules/ogygia/') || path.includes('virtual:ogygia')) return 'ogygia';
	if (path.includes('/node_modules/')) return 'dependency';
	if (path.includes('/src/')) return 'app';
	return 'dependency';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function analyze_cpu(trace: SelfProfileTrace, windows: IslandWindow[], longtasks: { t: number; ms: number }[], page_url: string): CpuSummary {
	const { frames, resources, samples, stacks } = trace;
	const origin = page_url ? new URL(page_url).origin : '';
	// the interval: the median gap (a stall between samples is not all CPU)
	const gaps: number[] = [];
	for (let i = 1; i < samples.length; i++) gaps.push(samples[i].timestamp - samples[i - 1].timestamp);
	gaps.sort((a, b) => a - b);
	const interval = gaps.length ? Math.max(1, gaps[gaps.length >> 1]) : 10;
	const cap = interval * 3;

	const fn_self = new Map<number, number>();
	const fn_total = new Map<number, number>();
	const kind_ms = new Map<CodeKind, number>();
	const file_ms = new Map<string, { kind: CodeKind; ms: number }>();
	const host_ms = new Map<string, number>();
	const page_host = host_of(page_url);
	const win_self = windows.map(() => new Map<number, number>());
	const win_ms = windows.map(() => 0);
	const out_self = new Map<number, number>();
	let out_ms = 0;
	let busy = 0;

	const frame_kind = (fid: number): CodeKind => {
		const f = frames[fid];
		return kind_of(f?.resourceId !== undefined ? (resources[f.resourceId] ?? '') : '', page_url);
	};

	for (let i = 0; i < samples.length; i++) {
		const s = samples[i];
		if (s.stackId === undefined) continue;
		const next = samples[i + 1];
		const dt = next ? Math.min(cap, Math.max(0, next.timestamp - s.timestamp)) : interval;
		if (dt <= 0) continue;
		busy += dt;
		const leaf = stacks[s.stackId]?.frameId;
		if (leaf === undefined) continue;
		fn_self.set(leaf, (fn_self.get(leaf) ?? 0) + dt);
		const k = frame_kind(leaf);
		kind_ms.set(k, (kind_ms.get(k) ?? 0) + dt);
		const lf = frames[leaf];
		if (lf?.resourceId !== undefined) {
			const file = clean_file(resources[lf.resourceId] ?? '', origin);
			const e = file_ms.get(file) ?? { kind: k, ms: 0 };
			e.ms += dt;
			file_ms.set(file, e);
		}
		// OTHER ORIGINS: the sample goes to the nearest frame with a script URL (a third-party script
		// spending its time in the browser's own APIs — layout, the DOM — still pays for it)
		for (let sid: number | undefined = s.stackId, guard = 0; sid !== undefined && guard < 512; guard++) {
			const st: { frameId: number; parentId?: number } | undefined = stacks[sid];
			if (!st) break;
			const rid = frames[st.frameId]?.resourceId;
			if (rid !== undefined) {
				const host = host_of(resources[rid] ?? '');
				if (host && host !== page_host) host_ms.set(host, (host_ms.get(host) ?? 0) + dt);
				break;
			}
			sid = st.parentId;
		}
		// totals: each frame once per sample (recursion counts once)
		const seen = new Set<number>();
		for (let sid: number | undefined = s.stackId, guard = 0; sid !== undefined && guard < 512; guard++) {
			const st: { frameId: number; parentId?: number } | undefined = stacks[sid];
			if (!st) break;
			if (!seen.has(st.frameId)) {
				seen.add(st.frameId);
				fn_total.set(st.frameId, (fn_total.get(st.frameId) ?? 0) + dt);
			}
			sid = st.parentId;
		}
		// which island's hydrate window it fell in (else: inside a long task?)
		let hit = false;
		for (let w = 0; w < windows.length; w++) {
			if (s.timestamp >= windows[w].from && s.timestamp <= windows[w].to) {
				win_ms[w] += dt;
				win_self[w].set(leaf, (win_self[w].get(leaf) ?? 0) + dt);
				hit = true;
				break;
			}
		}
		if (!hit && longtasks.some((t) => s.timestamp >= t.t && s.timestamp <= t.t + t.ms)) {
			out_ms += dt;
			out_self.set(leaf, (out_self.get(leaf) ?? 0) + dt);
		}
	}

	const fn_of = (fid: number, self: number, total: number): CpuFn => {
		const f = frames[fid] ?? {};
		const url = f.resourceId !== undefined ? (resources[f.resourceId] ?? '') : '';
		// (an unnamed function in a component's file — an `$effect`, an inline handler — is that
		// component's code, named so, as the profiler's analysis names it)
		const path = url.split('?')[0];
		const stem = path.endsWith('.svelte') ? path.slice(path.lastIndexOf('/') + 1, -'.svelte'.length) : '';
		return {
			name: f.name || stem || (url ? '(anonymous)' : '(browser)'),
			file: url ? clean_file(url, origin) : '',
			line: typeof f.line === 'number' ? f.line : null,
			kind: frame_kind(fid),
			self_ms: round1(self),
			total_ms: round1(total)
		};
	};
	const top = (m: Map<number, number>, n: number) =>
		[...m]
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([fid, ms]) => fn_of(fid, ms, fn_total.get(fid) ?? ms));

	const islands: CpuSummary['islands'] = {};
	windows.forEach((w, i) => {
		if (win_ms[i] > 0) islands[w.fp] = { ms: round1(win_ms[i]), top: top(win_self[i], 3) };
	});
	return {
		window_ms: samples.length ? round1(samples[samples.length - 1].timestamp - samples[0].timestamp) : 0,
		busy_ms: round1(busy),
		by_kind: [...kind_ms].map(([kind, ms]) => ({ kind, ms: round1(ms) })).sort((a, b) => b.ms - a.ms),
		fns: top(new Map([...fn_self].filter(([fid]) => frame_kind(fid) !== 'devtools')), 25),
		files: [...file_ms].map(([file, e]) => ({ file, kind: e.kind, ms: round1(e.ms) })).sort((a, b) => b.ms - a.ms).slice(0, 15),
		islands,
		outside: { ms: round1(out_ms), top: top(out_self, 3) },
		interval_ms: round1(interval),
		by_host: Object.fromEntries([...host_ms].map(([h, ms]) => [h, round1(ms)]))
	};
}

function host_of(url: string): string {
	try {
		return url ? new URL(url).host : '';
	} catch {
		return '';
	}
}

/** `name (file:line)` for a finding. */
export function fn_label(f: CpuFn): string {
	const where = f.file ? ` (${f.file.slice(f.file.lastIndexOf('/') + 1)}${f.line !== null ? `:${f.line}` : ''})` : '';
	return `${f.name}${where}`;
}

/** Is this a trace the analyzer can read. */
export function is_trace(x: unknown): x is SelfProfileTrace {
	const t = x as SelfProfileTrace | null;
	return !!t && Array.isArray(t.frames) && Array.isArray(t.samples) && Array.isArray(t.stacks) && Array.isArray(t.resources);
}
