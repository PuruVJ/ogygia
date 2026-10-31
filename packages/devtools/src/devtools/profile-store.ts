/* oxlint-disable no-explicit-any -- reads the profiler's JSON answer, untyped on the wire; every field is checked before use. */
/**
 * The devtools' copy of the last SSR profile per page — the native Profiler tab writes it, the Lens
 * roster and the island detail read it (joined by fingerprint, then by entry), so a server cost sits
 * next to the browser's numbers for the same island. Kept SLIM: the profiler's JSON answer is
 * hundreds of KB; the dock needs the score, the forecast, the findings, the islands, the top
 * components and the calls. The slim copy also survives a reload (sessionStorage, best effort).
 */

export interface SlimIsland {
	name: string;
	fp: string | null;
	entry: string | null;
	wake: string | null;
	ssr_ms: number | null;
	props_bytes: number | null;
	seed_refs: number;
	culprit: string | null;
	client_p50_ms: number | null;
	recovered: number;
	/** its first line that draws differently in the browser (the profiler's reading of its sources) */
	hazard?: { file: string; line: number; kind: 'await' | 'browser'; reads?: string; guard?: true };
}

export interface SlimProfile {
	id: string;
	page: string;
	at: number;
	runs: number[];
	render_ms: number;
	/** the Cache-Control the page answered the profiler's renders (what the browser cannot read) */
	cache_control?: string;
	/** the page is prerendered: 'file' (served as the build's file), 'route' (its route prerenders) */
	prerendered?: 'file' | 'route';
	score: {
		score: number;
		grade: string;
		categories: { key: string; label: string; score: number; value: string; lost: number; detail: string[] }[];
		missing: { label: string; why: string }[];
		/** since the last profile of this page */
		was?: { score: number; grade: string };
	} | null;
	/** what the page loads at start (a build only) */
	assets: {
		js: number;
		lazy_js: number;
		wire: number;
		files: { name: string; kind: string; bytes: number; lazy: boolean; contains: string[] }[];
		/** one module shipped as two copies, both loaded by this page: its files, their bytes, where each
		 *  came from, and what the second copy costs */
		twice?: { name: string; copies: { file: string; bytes: number; from?: string }[]; extra: number }[];
	} | null;
	forecast: { now_ms: number; after_ms: number; parts: { title: string; kind: string; ms: number; wait: boolean }[] } | null;
	findings: { severity: string; code: string; message: string; fix?: string; fps?: string[] }[];
	islands: SlimIsland[];
	components: { name: string; file: string | null; self_ms: number; total_ms: number; instances: number | null }[];
	network: { count: number; total_ms: number; sequential_ms: number; calls: { method: string; url: string; status: number | null; wait_ms: number }[] } | null;
	seed_bytes: number | null;
	links: { html: string; json: string } | null;
	/** named spans split by an element tag (`span('ds.render', …, { tag })`): the page's elements of it */
	spans: { name: string; total_ms: number; tags: { tag: string; count: number; ms: number }[] }[];
	/** the document as bytes: its size, what kind, and the declarative shadow roots in it */
	html: { total: number; shadow: number; shadow_count: number; by_kind: Record<string, number> } | null;
	/** the largest paint the browser saw (its tag, the island it sat in) */
	lcp: { tag: string | null; fp: string | null; ms: number | null } | null;
	/** the server's hottest code (own time, per render) */
	hot: { name: string; file: string | null; line: number | null; ms: number; kind: string }[];
}

/**
 * Profile a same-origin path on the server, now (the profiler's `/page?format=json`; a 409 = the
 * recorder is busy: wait and ask again). Stores the slim copy and returns it.
 */
export async function run_profile(path: string, runs = 3, base = '/__profiler'): Promise<SlimProfile> {
	const url = `${base}/page?p=${encodeURIComponent(path)}&runs=${runs}&format=json`;
	for (let tries = 0; tries < 30; tries++) {
		const r = await fetch(url, { headers: { accept: 'application/json' } });
		if (r.status === 409) {
			await new Promise((ok) => setTimeout(ok, 2000));
			continue;
		}
		if (!r.ok) {
			// (its words, not its JSON: the profiler answers `{ "error": "…" }` — a heap too full to
			// profile says what to do, and the sentence is the point)
			const text = await r.text();
			let said = text;
			try {
				const j = JSON.parse(text) as { error?: unknown; message?: unknown };
				said = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : text;
			} catch {
				// not JSON: the text itself
			}
			throw new Error(r.status === 503 ? said.slice(0, 600) : `the profiler answered ${r.status}: ${said.slice(0, 300)}`);
		}
		const p = slim_profile(await r.json());
		set_profile(p);
		return p;
	}
	throw new Error('another profile kept the recorder busy for a minute');
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
/** an island row's first hazard line — a value it renders before a guard around browser-only work */
function slim_hazard(v: unknown): { hazard?: NonNullable<SlimIsland['hazard']> } {
	const list = arr(v).filter((h) => typeof h.file === 'string' && typeof h.line === 'number' && (h.kind === 'await' || h.kind === 'browser'));
	const h = list.find((x) => !x.guard) ?? list[0];
	return h ? { hazard: { file: h.file, line: h.line, kind: h.kind, ...(typeof h.reads === 'string' ? { reads: h.reads } : {}), ...(h.guard === true ? { guard: true as const } : {}) } } : {};
}

function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The profiler's JSON answer (`/page?format=json`) cut to what the dock shows. Tolerant: a field
 *  the report lacks is left empty, never a throw. */
export function slim_profile(r: Record<string, any>): SlimProfile {
	const target = r?.target ?? {};
	// (`runs` are the renders with the profiler's own cost taken out — the forecast's base)
	const runs = (Array.isArray(target.runs) ? target.runs : []).filter((x: unknown) => typeof x === 'number');
	const sc = r?.score;
	const fc = r?.forecast;
	const net = r?.network;
	const order: Record<string, number> = { error: 0, warn: 1, info: 2 };
	return {
		id: String(r?.id ?? ''),
		page: String(target.page ?? ''),
		at: num(r?.created) ?? Date.now(),
		runs,
		render_ms: Math.round(median(runs) * 10) / 10,
		...(typeof target.cache_control === 'string' && target.cache_control ? { cache_control: target.cache_control.slice(0, 200) } : {}),
		...(target.prerendered === 'file' || target.prerendered === 'route' ? { prerendered: target.prerendered } : {}),
		score:
			sc && typeof sc.score === 'number'
				? {
						score: sc.score,
						grade: String(sc.grade ?? ''),
						categories: arr(sc.categories).map((c) => ({
							key: String(c.key),
							label: String(c.label ?? c.key),
							score: num(c.score) ?? 0,
							value: String(c.value ?? ''),
							lost: num(c.lost) ?? 0,
							detail: Array.isArray(c.detail) ? c.detail.map(String).slice(0, 4) : []
						})),
						missing: arr(sc.missing).map((m) => ({ label: String(m.label ?? m.key), why: String(m.why ?? '') })),
						...(typeof r?.since?.score?.a === 'number' ? { was: { score: r.since.score.a, grade: String(r.since.score.a_grade ?? '') } } : {})
					}
				: null,
		assets: r?.assets?.totals
			? {
					js: num(r.assets.totals.js) ?? 0,
					lazy_js: num(r.assets.totals.lazy_js) ?? 0,
					wire: num(r.assets.totals.wire) ?? 0,
					files: arr(r.assets.files)
						.slice(0, 10)
						.map((f) => ({
							name: String(f.url ?? '').split('?')[0].split('/').pop() ?? '',
							kind: String(f.kind ?? ''),
							bytes: num(f.bytes) ?? 0,
							lazy: !!f.lazy,
							contains: Array.isArray(f.contains) ? f.contains.map(String).slice(0, 4) : []
						})),
					...(() => {
						const twice = arr(r.assets.twice)
							.slice(0, 8)
							.map((d) => ({
								name: String(d.name ?? ''),
								copies: arr(d.copies)
									.slice(0, 3)
									.map((c) => ({ file: String(c.file ?? ''), bytes: num(c.bytes) ?? 0, ...(typeof c.from === 'string' ? { from: c.from } : {}) })),
								extra: num(d.extra) ?? 0
							}))
							.filter((d) => d.name && d.copies.length >= 2);
						return twice.length ? { twice } : {};
					})()
				}
			: null,
		forecast:
			fc && typeof fc.now_ms === 'number'
				? {
						now_ms: fc.now_ms,
						after_ms: num(fc.after_ms) ?? fc.now_ms,
						parts: arr(fc.parts)
							.slice(0, 8)
							.map((p) => ({ title: String(p.title ?? p.kind), kind: String(p.kind ?? ''), ms: num(p.ms) ?? 0, wait: !!p.wait }))
					}
				: null,
		findings: arr(r?.findings)
			.filter((f) => f.code !== 'summary')
			.map((f) => ({
				severity: String(f.severity ?? 'info'),
				code: String(f.code ?? ''),
				message: String(f.message ?? ''),
				...(f.fix ? { fix: String(f.fix) } : {}),
				// a browser finding's islands (the visit's analysis): lit on the page from the tab
				...(Array.isArray(f.fps) && f.fps.length ? { fps: f.fps.slice(0, 40).map(String) } : {})
			}))
			.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
			.slice(0, 30),
		islands: arr(r?.ogygia?.island_rows).map((i) => ({
			name: String(i.name ?? ''),
			fp: str(i.fp),
			entry: str(i.entry),
			wake: str(i.wake),
			ssr_ms: num(i.ssr_ms),
			props_bytes: num(i.props_bytes),
			seed_refs: num(i.seed_refs) ?? 0,
			culprit: str(i.devalue_culprit),
			client_p50_ms: num(i.client?.p50_ms),
			recovered: num(i.client?.recovered) ?? 0,
			...slim_hazard(i.hazards)
		})),
		components: arr(r?.components)
			.slice(0, 12)
			.map((c) => ({ name: String(c.name ?? ''), file: str(c.file), self_ms: num(c.self_ms) ?? 0, total_ms: num(c.total_ms) ?? 0, instances: num(c.instances) })),
		network: net
			? {
					count: num(net.count) ?? 0,
					total_ms: num(net.total_ms) ?? 0,
					sequential_ms: num(net.sequential_ms) ?? 0,
					calls: arr(net.calls)
						.slice(0, 20)
						.map((c) => ({ method: String(c.method ?? 'GET'), url: String(c.url ?? ''), status: num(c.status), wait_ms: num(c.wait_ms) ?? 0 }))
				}
			: null,
		seed_bytes: num(r?.ogygia?.seed_bytes),
		links: r?.links?.html ? { html: String(r.links.html), json: String(r.links.json ?? '') } : null,
		spans: arr(r?.spans)
			.filter((s) => Array.isArray(s?.by?.tag) && s.by.tag.length)
			.slice(0, 6)
			.map((s) => ({
				name: String(s.name ?? ''),
				total_ms: num(s.total_ms) ?? 0,
				tags: arr(s.by.tag)
					.slice(0, 8)
					// its SHARE of the CPU (spans overlap: their summed durations count each wait many times)
					.map((t) => ({ tag: String(t.value ?? ''), count: num(t.count) ?? 0, ms: num(t.share_ms) ?? num(t.wall_ms) ?? 0 }))
			})),
		html: r?.strip
			? {
					total: num(r.strip.total) ?? 0,
					shadow: num(r.strip.by_kind?.shadow) ?? 0,
					shadow_count: num(r.strip.shadow_count) ?? 0,
					by_kind: Object.fromEntries(Object.entries(r.strip.by_kind ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>
				}
			: null,
		lcp: r?.browser?.visit?.paints
			? { tag: str(r.browser.visit.paints.lcp_tag), fp: str(r.browser.visit.paints.lcp_fp), ms: num(r.browser.visit.paints.lcp) }
			: null,
		hot: arr(r?.hot_functions)
			.filter((f) => f.category !== 'profiler' && f.category !== 'idle')
			.slice(0, 6)
			.map((f) => ({
				name: String(f.label || f.name || '(anonymous)').slice(0, 80),
				file: str(f.file),
				line: num(f.line),
				ms: Math.round(((num(f.self_ms) ?? 0) / Math.max(1, runs.length)) * 10) / 10,
				kind: String(f.category ?? '')
			}))
	};
}

/** The server row for an island: by fingerprint, else by entry (the same island with other props). */
export function island_row(p: SlimProfile | null, fp: string | null, entry: string | null): SlimIsland | null {
	if (!p) return null;
	if (fp) {
		const hit = p.islands.find((i) => i.fp === fp);
		if (hit) return hit;
	}
	if (entry) {
		const tail = entry.slice(entry.lastIndexOf('/') + 1);
		return p.islands.find((i) => i.entry && i.entry.slice(i.entry.lastIndexOf('/') + 1) === tail) ?? null;
	}
	return null;
}

// ── the store: one slim profile per page path, plus a change counter the tabs read on their tick ──
const KEY = 'ogygia:devtools:profiles:v1';
const by_page = new Map<string, SlimProfile>();
let loaded = false;
let version = 0;

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		const raw = sessionStorage.getItem(KEY);
		const list = raw ? (JSON.parse(raw) as SlimProfile[]) : [];
		for (const p of list) if (p && p.page) by_page.set(p.page, p);
	} catch {
		// private mode / quota: memory only
	}
}

export function set_profile(p: SlimProfile): void {
	load();
	by_page.set(p.page, p);
	version++;
	try {
		// newest 8 pages
		const list = [...by_page.values()].sort((a, b) => b.at - a.at).slice(0, 8);
		sessionStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		// memory only
	}
}

export function profile_for(page: string): SlimProfile | null {
	load();
	return by_page.get(page) ?? null;
}

export function profiles_version(): number {
	return version;
}
