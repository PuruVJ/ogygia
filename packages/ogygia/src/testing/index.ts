/**
 * `ogygia/testing` — the devtools and the profiler as test primitives, for any runner and any page
 * driver. Your integration tests do what they do; ogygia measures it:
 *
 *  - `page()` — the page load as the browser measured it: vitals, each island's wake, the findings
 *  - `hydration()` — every island's hydration status, with the diff of a changed one
 *  - `record(actions)` — what your actions did: slow interactions (and the function behind each),
 *    dead / repeated clicks, requests with the server's own split, long tasks, shifts, errors…
 *  - `profile(path)` — the SSR profiler's report of a path (score, forecast, findings, weight)
 *
 * With Playwright (ogygia does not import it — you hand it your `test` and `expect`):
 *
 * ```ts
 * import { test as base, expect as baseExpect } from '@playwright/test';
 * import { withOgygia } from 'ogygia/testing';
 * export const { test, expect } = withOgygia(base, baseExpect);
 *
 * test('checkout stays fast', async ({ page, ogygia }) => {
 *   await page.goto('/cart');
 *   expect(await ogygia.page()).toMeetBudget({ lcp: 2500, cls: 0.1 });
 *   expect(await ogygia.hydration()).toHydrateCleanly();
 *   const session = await ogygia.record(() => page.getByRole('button', { name: 'Buy' }).click());
 *   expect(session).toHaveNoFindings({ severity: 'warn' });
 *   expect(await ogygia.profile('/cart')).toMeetBudget({ score: 80, renderMs: 200 });
 * });
 * ```
 *
 * Anything else (Puppeteer, WebdriverIO, a custom harness): `createOgygia(driver)` with a driver
 * that can run a function in the page and make a request; `expect.extend(ogygiaMatchers)` in
 * Vitest / Jest. Every report is plain JSON: keep them (the Playwright fixture attaches them to each
 * test as `ogygia.json`) and `compare` / `toMarkdown` two runs in a CI script.
 *
 * Needs a server with `ogygia({ devtools: true })` (the dev server, or a preview build: measuring
 * starts for a browser with the `og_devtools=1` cookie, which `withOgygia` sets for `baseURL`).
 * `profile()` needs `ogygia({ profiler: true })` (and its key on a build).
 */
import type { PageFinding, RatedVital, IslandRow } from '../devtools/page-insights.js';
import type { SessionReport } from '../devtools/session-insights.js';
import type { HydrationStatus } from '../devtools/hydration.js';
import type { HtmlDiff } from '../devtools/html-diff.js';
import { assets_diff } from '../profiler/page-assets.js';
import type { TestType, Expect, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';

// ── the reports (plain JSON, as the page hands them over) ──

export interface OgygiaPageReport {
	kind: 'page';
	url: string;
	nav: { to: string; t: number } | null;
	vitals: RatedVital[];
	islands: IslandRow[];
	findings: (PageFinding & { names: string[] })[];
	blocking: { url: string; ms: number; bytes: number }[];
	bytes: { type: string; count: number; transfer: number; size: number }[];
	longtask_ms: number;
	cpu: { busy_ms: number; by_kind: { kind: string; ms: number }[]; fns: { name: string; file: string; line: number | null; self_ms: number; total_ms: number }[] } | null;
	/** what the test's browser cannot measure (WebKit: layout shifts, long tasks, interaction timing,
	 *  the CPU sampler): findings that need them cannot appear, whatever the page does */
	unmeasured: string[];
}

export interface OgygiaHydrationReport {
	kind: 'hydration';
	measured: boolean;
	islands: { fp: string; name: string; wake: string; status: HydrationStatus; reason: string; diff: HtmlDiff | null }[];
}

export type OgygiaSessionReport = SessionReport & {
	kind: 'session';
	timeline: unknown[];
	/** what the test's browser cannot measure (see OgygiaPageReport) */
	unmeasured: string[];
	/** with `record(actions, { server: true })`: the server over the same stretch — its CPU across
	 *  every request the actions made, their outbound calls, the requests (the profiler's window) */
	server?: OgygiaProfileReport & { window: { ms: number; requests: { method: string; path: string; route: string | null; ms: number; status: number | null }[] } };
};

/** The profiler's JSON answer (`/__profiler/page?format=json`), the fields a test reads first typed. */
export interface OgygiaProfileReport {
	kind: 'profile';
	id: string;
	target: { page: string; runs: number[] };
	score: { score: number; grade: string; categories: { key: string; label: string; score: number; value: string; lost?: number }[]; missing: { key: string; label: string; why: string }[] } | null;
	forecast: { now_ms: number; after_ms: number } | null;
	findings: { severity: string; code: string; message: string; fix?: string }[];
	/** the page's weight (a build), or `{ missing }` why it was not weighed (a dev server) */
	assets: {
		totals?: { js: number; wire: number; lazy_js: number };
		missing?: string;
		/** the heaviest files (what each holds, where the build said): what `compare` diffs across builds */
		files?: { url: string; kind: string; bytes: number; contains?: string[]; lazy?: boolean }[];
	} | null;
	links: { html: string; json: string };
	[key: string]: unknown;
}

export type OgygiaReport = OgygiaPageReport | OgygiaHydrationReport | OgygiaSessionReport | OgygiaProfileReport;

// ── the driver: whatever runs your browser ──

/**
 * What ogygia needs from a page driver. Playwright's `Page` fits as is (`withOgygia` wires it);
 * Puppeteer's too (`evaluate`, and `fetch` for the profiler).
 */
export interface OgygiaDriver {
	/** run `fn(arg)` in the page and return its (JSON) result */
	evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
	/** GET a URL relative to the app (for `profile()`); default: `fetch` inside the page */
	get?(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
	/** POST to a URL relative to the app (the server window of `record(…, { server: true })`);
	 *  default: `fetch` inside the page */
	post?(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
	/** wait `ms` (default: a timer) */
	wait?(ms: number): Promise<void>;
}

export interface OgygiaOptions {
	/** the profiler's key, for `profile()` on a build (a dev server needs none) */
	profilerKey?: string;
	/** where the profiler is mounted (default `/__profiler`) */
	profilerBase?: string;
	/** how long to wait for the page's testing API (default 15 s) */
	timeout?: number;
}

export interface Ogygia {
	page(): Promise<OgygiaPageReport>;
	hydration(): Promise<OgygiaHydrationReport>;
	/** `server: true` also records the server over the same stretch (needs `ogygia({ profiler: true })`) */
	record(actions: () => Promise<unknown>, opts?: { server?: boolean }): Promise<OgygiaSessionReport>;
	profile(path: string, opts?: { runs?: number }): Promise<OgygiaProfileReport>;
	/** wait until no island is waking or hydrating */
	settled(opts?: { quiet?: number; timeout?: number }): Promise<boolean>;
	/** every report taken so far, in order */
	readonly reports: OgygiaReport[];
}

const NOT_THERE =
	"ogygia's testing API is not in this page. Serve the app with `ogygia({ devtools: true })` " +
	'(the dev server, or a preview build) and open a csr = false page.';

/** The primitives over any driver. */
export function createOgygia(driver: OgygiaDriver, options: OgygiaOptions = {}): Ogygia {
	const wait = driver.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const reports: OgygiaReport[] = [];
	const keep = <T extends OgygiaReport>(r: T): T => (reports.push(r), r);
	const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
		const until = Date.now() + (options.timeout ?? 15_000);
		while (!(await driver.evaluate(() => !!(window as { __ogygia_testing?: unknown }).__ogygia_testing, null))) {
			if (Date.now() > until) throw new Error(NOT_THERE);
			await wait(100);
		}
		return driver.evaluate(
			async ([n, a]: readonly [string, unknown[]]) => {
				const t = (window as unknown as { __ogygia_testing: Record<string, (...x: unknown[]) => Promise<unknown>> }).__ogygia_testing;
				return t[n](...a) as unknown;
			},
			[name, args] as const
		) as Promise<T>;
	};
	const get =
		driver.get ??
		((url: string, headers: Record<string, string>) =>
			driver.evaluate(
				async ([u, h]: readonly [string, Record<string, string>]) => {
					const r = await fetch(u, { headers: h });
					return { status: r.status, body: await r.text() };
				},
				[url, headers] as const
			));
	const post =
		driver.post ??
		((url: string, headers: Record<string, string>) =>
			driver.evaluate(
				async ([u, h]: readonly [string, Record<string, string>]) => {
					const r = await fetch(u, { method: 'POST', headers: h });
					return { status: r.status, body: await r.text() };
				},
				[url, headers] as const
			));
	return {
		reports,
		async page() {
			await call('settled', 300, 10_000);
			const r = await call<Omit<OgygiaPageReport, 'kind'> | null>('page');
			if (!r) throw new Error('the page load was not measured: in a build, the browser needs the `og_devtools=1` cookie before the page loads');
			return keep({ kind: 'page', ...r });
		},
		async hydration() {
			await call('settled', 300, 10_000);
			return keep({ kind: 'hydration', ...(await call<Omit<OgygiaHydrationReport, 'kind'>>('hydration')) });
		},
		async record(actions, ropts) {
			await call('settled', 300, 10_000);
			const b = options.profilerBase ?? '/__profiler';
			const headers = { accept: 'application/json', ...(options.profilerKey ? { 'x-profiler-key': options.profilerKey } : {}) };
			if (ropts?.server) {
				// the server window first (a 409: another recording holds the recorder — wait for it)
				for (let tries = 0; ; tries++) {
					const s = await post(`${b}/window/start`, headers);
					if (s.status === 200) break;
					if (s.status !== 409 || tries >= 30) throw new Error(`the profiler could not start a window (${s.status}): ${s.body.slice(0, 200)}`);
					await wait(2000);
				}
			}
			await call('record_start');
			let r: Omit<OgygiaSessionReport, 'kind'> | null = null;
			let server: OgygiaSessionReport['server'];
			try {
				await actions();
				await wait(600); // the last entries (a paint, a late request) land
			} finally {
				r = await call<Omit<OgygiaSessionReport, 'kind'> | null>('record_stop');
				if (ropts?.server) {
					const s = await post(`${b}/window/stop`, headers);
					if (s.status !== 200) throw new Error(`the profiler's window failed (${s.status}): ${s.body.slice(0, 200)}`);
					const json = JSON.parse(s.body) as Record<string, unknown>;
					server = { ...json, mode: json.kind, kind: 'profile' } as unknown as OgygiaSessionReport['server'];
				}
			}
			if (!r) throw new Error('the recording was lost (did the page navigate to another document while it ran?)');
			return keep({ kind: 'session', ...r, ...(server ? { server } : {}) });
		},
		async profile(path, opts) {
			const b = options.profilerBase ?? '/__profiler';
			const res = await get(`${b}/page?p=${encodeURIComponent(path)}&runs=${opts?.runs ?? 3}&format=json`, {
				accept: 'application/json',
				...(options.profilerKey ? { 'x-profiler-key': options.profilerKey } : {})
			});
			if (res.status !== 200) throw new Error(`the profiler answered ${res.status} for ${path}: ${res.body.slice(0, 200)}`);
			// (the profiler's JSON carries its own `kind` — the recording mode — so ours goes last)
			const json = JSON.parse(res.body) as Omit<OgygiaProfileReport, 'kind'> & { kind?: string };
			return keep({ ...json, mode: json.kind, kind: 'profile' } as unknown as OgygiaProfileReport);
		},
		settled: (o) => call<boolean>('settled', o?.quiet ?? 300, o?.timeout ?? 10_000)
	};
}

// ── Playwright, without importing it at runtime (types only: they vanish in the build) ──

export type OgygiaTestOptions = OgygiaOptions & {
	/** attach every report to the test result as `ogygia.json` (default true) */
	attach?: boolean;
};

/**
 * Your Playwright `test` with an `ogygia` fixture, and your `expect` with ogygia's matchers.
 * Options per project: `use: { ogygiaOptions: { profilerKey, attach: false } }`.
 */
export function withOgygia<TA extends PlaywrightTestArgs & PlaywrightTestOptions, WA extends PlaywrightWorkerArgs & PlaywrightWorkerOptions>(
	test: TestType<TA, WA>,
	expect: Expect
): { test: TestType<TA & { ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions }, WA>; expect: Expect } {
	// (extended on Playwright's own base shape: its fixture types do not resolve through a generic)
	const base = test as unknown as TestType<PlaywrightTestArgs & PlaywrightTestOptions, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
	const extended = base.extend<{ ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions }>({
		ogygiaOptions: [{}, { option: true }],
		ogygia: async ({ page, baseURL, ogygiaOptions }, use, testInfo) => {
			// measure from the first load on (a build measures only a browser that opted in)
			if (baseURL) await page.context().addCookies([{ name: 'og_devtools', value: '1', url: baseURL }]);
			const o = createOgygia(
				{
					// (Playwright's `Unboxed<A>` arg typing is stricter than the driver's plain JSON arg)
					evaluate: (fn, arg) => page.evaluate(fn as (a: unknown) => never, arg as never),
					wait: (ms) => page.waitForTimeout(ms),
					async get(url, headers) {
						const r = await page.request.get(url, { headers, timeout: 120_000 });
						return { status: r.status(), body: await r.text() };
					},
					async post(url, headers) {
						// (an Origin header: a SvelteKit app refuses a cross-site POST without one)
						const origin = baseURL ? new URL(baseURL).origin : undefined;
						const r = await page.request.post(url, { headers: { ...headers, ...(origin ? { origin } : {}) }, timeout: 120_000 });
						return { status: r.status(), body: await r.text() };
					}
				},
				ogygiaOptions
			);
			await use(o);
			if (ogygiaOptions.attach !== false && o.reports.length)
				await testInfo.attach('ogygia.json', {
					body: JSON.stringify({ test: testInfo.titlePath.join(' › '), status: testInfo.status, reports: o.reports.map(forAttachment) }, null, 1),
					contentType: 'application/json'
				});
		}
	});
	return { test: extended as unknown as TestType<TA & { ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions }, WA>, expect: expect.extend(ogygiaMatchers) as unknown as Expect };
}

/** A report as kept for a comparison (a profile's full JSON is large). */
export function forAttachment(r: OgygiaReport): unknown {
	const slim_profile = (p: OgygiaProfileReport) => ({
		kind: 'profile',
		id: p.id,
		target: p.target,
		score: p.score,
		forecast: p.forecast,
		findings: p.findings,
		assets: p.assets ? { totals: p.assets.totals, missing: p.assets.missing, ...(p.assets.files ? { files: p.assets.files } : {}) } : null,
		links: p.links,
		...((p as { window?: unknown }).window ? { window: (p as { window?: unknown }).window } : {}),
		hot_functions: ((p as { hot_functions?: unknown[] }).hot_functions ?? []).slice(0, 10)
	});
	if (r.kind === 'profile') return slim_profile(r);
	if (r.kind === 'session' && r.server) return { ...r, server: slim_profile(r.server) };
	return r;
}

// ── matchers (any runner's `expect.extend`) ──

type Severity = 'info' | 'warn' | 'error';
const SEV: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export interface Budget {
	// page
	lcp?: number;
	fcp?: number;
	cls?: number;
	inp?: number;
	ttfb?: number;
	longTaskMs?: number;
	/** the slowest island's wake to hydrated, ms */
	islandWakeMs?: number;
	// session
	maxInteractionMs?: number;
	slowInteractions?: number;
	errors?: number;
	failedRequests?: number;
	/** with `record(…, { server: true })`: the server's busy CPU over the session, ms */
	serverBusyMs?: number;
	// profile
	score?: number;
	renderMs?: number;
	jsBytes?: number;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : 0;
}

/** Each line of a budget against a report: `{ key, measured, limit, ok }`. */
export function checkBudget(r: OgygiaReport, b: Budget): { key: string; measured: number | null; limit: number; ok: boolean }[] {
	const out: { key: string; measured: number | null; limit: number; ok: boolean }[] = [];
	const le = (key: string, v: number | null | undefined, limit: number | undefined) => {
		if (limit !== undefined) out.push({ key, measured: v ?? null, limit, ok: v !== undefined && v !== null && v <= limit });
	};
	const ge = (key: string, v: number | null | undefined, limit: number | undefined) => {
		if (limit !== undefined) out.push({ key, measured: v ?? null, limit, ok: v !== undefined && v !== null && v >= limit });
	};
	if (r.kind === 'page') {
		const vit = (k: string) => r.vitals.find((x) => x.key === k)?.value;
		le('lcp', vit('lcp'), b.lcp);
		le('fcp', vit('fcp'), b.fcp);
		le('cls', vit('cls'), b.cls);
		le('inp', vit('inp'), b.inp);
		le('ttfb', vit('ttfb'), b.ttfb);
		le('longTaskMs', r.longtask_ms, b.longTaskMs);
		le('islandWakeMs', r.islands.length ? Math.max(...r.islands.map((i) => i.done - i.t0)) : 0, b.islandWakeMs);
	} else if (r.kind === 'session') {
		le('maxInteractionMs', r.interactions.length ? Math.max(...r.interactions.map((i) => i.duration)) : 0, b.maxInteractionMs);
		le('slowInteractions', r.counts.slow, b.slowInteractions);
		le('errors', r.counts.errors, b.errors);
		le('longTaskMs', r.counts.longtask_ms, b.longTaskMs);
		le('failedRequests', r.requests.filter((q) => q.status !== null && q.status >= 400).length, b.failedRequests);
		le('serverBusyMs', (r.server as { summary?: { busy_ms?: number } } | undefined)?.summary?.busy_ms, b.serverBusyMs);
	} else if (r.kind === 'profile') {
		ge('score', r.score?.score, b.score);
		le('renderMs', r.target?.runs?.length ? median(r.target.runs) : null, b.renderMs);
		le('jsBytes', r.assets?.totals?.js, b.jsBytes);
	}
	return out;
}

/** `expect.extend(ogygiaMatchers)` — Playwright, Vitest and Jest all take this shape. */
export const ogygiaMatchers = {
	/** No finding at or above `severity` (default: any), except the codes in `ignore`. */
	toHaveNoFindings(received: OgygiaReport, opts: { severity?: Severity; ignore?: string[] } = {}) {
		const min = SEV[opts.severity ?? 'info'];
		const list = ('findings' in received ? (received.findings as { code: string; severity: string; message: string }[]) : []).filter(
			(f) => (SEV[f.severity as Severity] ?? 0) >= min && !(opts.ignore ?? []).includes(f.code)
		);
		const pass = list.length === 0;
		return {
			pass,
			name: 'toHaveNoFindings',
			message: () =>
				pass
					? 'expected ogygia findings, found none'
					: `expected no ogygia findings${opts.severity ? ` at ${opts.severity} or above` : ''}, found ${list.length}:\n` + list.map((f) => `  - [${f.severity}] ${f.code}: ${f.message}`).join('\n')
		};
	},
	/** Every line of the budget met (see {@link Budget}: page, session and profile lines). */
	toMeetBudget(received: OgygiaReport, budget: Budget) {
		const bad = checkBudget(received, budget).filter((l) => !l.ok);
		return {
			pass: bad.length === 0,
			name: 'toMeetBudget',
			message: () =>
				bad.length
					? `ogygia budget missed (${received.kind}):\n` + bad.map((l) => `  - ${l.key}: ${l.measured ?? 'not measured'} (budget ${l.limit})`).join('\n')
					: 'expected the ogygia budget to be missed, it was met'
		};
	},
	/** No island failed, recovered, or changed its markup on hydration (`allow` some statuses). */
	toHydrateCleanly(received: OgygiaReport, opts: { allow?: HydrationStatus[] } = {}) {
		if (received.kind !== 'hydration') return { pass: false, name: 'toHydrateCleanly', message: () => 'toHydrateCleanly takes the report of ogygia.hydration()' };
		const allow = new Set<HydrationStatus>(['clean', 'asleep', ...(opts.allow ?? [])]);
		const bad = received.islands.filter((i) => !allow.has(i.status));
		return {
			pass: bad.length === 0,
			name: 'toHydrateCleanly',
			message: () =>
				bad.length
					? 'islands that did not hydrate cleanly:\n' +
						bad
							.map((i) => {
								const first = i.diff?.hunks[0]?.ops
									.filter((o) => o.op !== 'same')
									.slice(0, 2)
									.map((o) => `${o.op === 'del' ? '−' : '+'}${o.text}`)
									.join(' ');
								return `  - ${i.name}: ${i.status}${i.reason ? ` (${i.reason})` : ''}${first ? ` — ${first}` : ''}`;
							})
							.join('\n')
					: 'expected an island to hydrate badly, all were clean'
		};
	}
};

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace PlaywrightTest {
		interface Matchers<R> {
			toHaveNoFindings(opts?: { severity?: Severity; ignore?: string[] }): R;
			toMeetBudget(budget: Budget): R;
			toHydrateCleanly(opts?: { allow?: HydrationStatus[] }): R;
		}
	}
}

// ── two runs side by side (a CI script: gather each run's `ogygia.json` attachments) ──

export interface RunDiff {
	test: string;
	kind: OgygiaReport['kind'];
	score?: { base: number; head: number };
	renderMs?: { base: number; head: number };
	/** JS at start, base → head, and the files behind the move (new / grew / shrank / gone, known by
	 *  what they hold: hashed names change every build) */
	js?: { base: number; head: number; changes: string[] };
	findings: { added: string[]; fixed: string[] };
}

/** What changed between two runs of the same tests (each: the `ogygia.json` bodies, parsed). */
export function compare(baseRun: { test: string; reports: OgygiaReport[] }[], headRun: { test: string; reports: OgygiaReport[] }[]): RunDiff[] {
	const out: RunDiff[] = [];
	const lines = (r: OgygiaReport) => ('findings' in r ? (r.findings as { code: string; message: string }[]).map((f) => ({ code: f.code, text: `${f.code}: ${f.message.slice(0, 140)}` })) : []);
	for (const h of headRun) {
		const b = baseRun.find((x) => x.test === h.test);
		h.reports.forEach((hr, i) => {
			const nth = h.reports.slice(0, i).filter((x) => x.kind === hr.kind).length;
			const br = b?.reports.filter((x) => x.kind === hr.kind)[nth];
			const bl = br ? lines(br) : [];
			const hl = lines(hr);
			const d: RunDiff = {
				test: h.test,
				kind: hr.kind,
				findings: {
					added: hl.filter((x) => !bl.some((y) => y.code === x.code)).map((x) => x.text),
					fixed: bl.filter((x) => !hl.some((y) => y.code === x.code)).map((x) => x.text)
				}
			};
			if (hr.kind === 'profile' && br?.kind === 'profile') {
				if (hr.score && br.score) d.score = { base: br.score.score, head: hr.score.score };
				if (hr.target?.runs?.length && br.target?.runs?.length) d.renderMs = { base: median(br.target.runs), head: median(hr.target.runs) };
				const ba = br.assets;
				const ha = hr.assets;
				if (ba?.totals && ha?.totals && ba.files && ha.files) {
					const diff = assets_diff({ assets: ba.files, totals: ba.totals }, { assets: ha.files, totals: ha.totals });
					const kb = (n: number) => `${Math.round(n / 1024)} KB`;
					const what = (c: { name: string; contains?: string[] }) => (c.contains?.length ? c.contains.slice(0, 2).join(', ') : c.name);
					d.js = {
						base: ba.totals.js,
						head: ha.totals.js,
						changes: [
							...diff.added.map((c) => `new ${what(c)} ${kb(c.b)}${c.lazy ? ' (loads later)' : ''}`),
							...diff.grew.map((c) => `grew ${what(c)} ${kb(c.a)} → ${kb(c.b)}`),
							...diff.shrank.map((c) => `shrank ${what(c)} ${kb(c.a)} → ${kb(c.b)}`),
							...diff.removed.map((c) => `gone ${what(c)} ${kb(c.a)}`),
							...diff.to_start.map((c) => `now at start ${what(c)} ${kb(c.b)} (loaded later before)`),
							...diff.to_later.map((c) => `now loads later ${what(c)} ${kb(c.b)}`)
						]
					};
				}
			}
			out.push(d);
		});
	}
	return out;
}

/** A markdown summary of {@link compare}'s answer — the body of a PR comment. */
export function toMarkdown(diffs: RunDiff[]): string {
	const moved = diffs.filter(
		(d) =>
			d.findings.added.length ||
			d.findings.fixed.length ||
			(d.score && d.score.base !== d.score.head) ||
			(d.renderMs && Math.abs(d.renderMs.head - d.renderMs.base) >= 5) ||
			(d.js && (d.js.changes.length || Math.abs(d.js.head - d.js.base) >= 5 * 1024))
	);
	if (!moved.length) return '**ogygia**: no change in the measured tests.';
	const out = ['**ogygia**: what changed', ''];
	for (const d of moved) {
		out.push(`- **${d.test}** (${d.kind})`);
		if (d.score && d.score.base !== d.score.head) out.push(`  - score ${d.score.base} → ${d.score.head}`);
		if (d.renderMs && Math.abs(d.renderMs.head - d.renderMs.base) >= 5) out.push(`  - server render ${Math.round(d.renderMs.base)} → ${Math.round(d.renderMs.head)} ms`);
		if (d.js && (d.js.changes.length || Math.abs(d.js.head - d.js.base) >= 5 * 1024))
			out.push(`  - JS at start ${Math.round(d.js.base / 1024)} → ${Math.round(d.js.head / 1024)} KB${d.js.changes.length ? `: ${d.js.changes.join('; ')}` : ''}`);
		for (const f of d.findings.added) out.push(`  - new: ${f}`);
		for (const f of d.findings.fixed) out.push(`  - fixed: ${f}`);
	}
	return out.join('\n');
}
