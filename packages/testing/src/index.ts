/**
 * `@ogygia/testing` — the devtools and the profiler as test primitives, for any runner and any page
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
 * import { withOgygia } from '@ogygia/testing';
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
 * Needs a server with the devtools plugin (`plugins: [ogygia(), devtools(), sveltekit()]`: the dev server, or a preview build: measuring
 * starts for a browser that turned devtools on — the `og_devtools=on` cookie, which `withOgygia` sets
 * for `baseURL`, or without one for the origin of the first page the test opens).
 * `profile()` needs the devtools plugin's profiler, `devtools({ profiler })` (and its key on a build).
 */
import type {
	PageFinding,
	RatedVital,
	IslandRow,
	SessionReport,
	HydrationStatus,
	HtmlDiff
} from '@ogygia/core/insights';
import {
	assets_diff,
	DEVTOOLS_COOKIE,
	DEVTOOLS_ON,
	TESTING_COOKIE,
	TESTING_LEAN,
	TESTING_ENGINE_VERSION
} from '@ogygia/core/insights';
import type {
	TestType,
	Expect,
	Page,
	Route,
	PlaywrightTestArgs,
	PlaywrightTestOptions,
	PlaywrightWorkerArgs,
	PlaywrightWorkerOptions
} from '@playwright/test';

// ── the reports (plain JSON, as the page hands them over) ──

export interface OgygiaPageReport {
	kind: 'page';
	engine: OgygiaEngine;
	/** what MEASURING cost this page, which no visitor with devtools off pays — subtract it: `script_ms`,
	 *  the main-thread time of ogygia's own measuring so far (by `phases`); `bytes`, the decoded size of
	 *  the testing engine's files. Engine 3 */
	self?: { script_ms: number; bytes: number; phases: Record<string, number> };
	url: string;
	/** the SvelteKit route id the server rendered (`/[lang]/about-us`), from a build with devtools on;
	 *  null on the dev server or an engine before 3 */
	route?: string | null;
	nav: { to: string; t: number } | null;
	vitals: RatedVital[];
	islands: IslandRow[];
	findings: (PageFinding & { names: string[] })[];
	blocking: { url: string; ms: number; bytes: number }[];
	bytes: { type: string; count: number; transfer: number; size: number }[];
	longtask_ms: number;
	cpu: {
		busy_ms: number;
		by_kind: { kind: string; ms: number }[];
		fns: { name: string; file: string; line: number | null; self_ms: number; total_ms: number }[];
	} | null;
	/** what the test's browser cannot measure (WebKit: layout shifts, long tasks, interaction timing,
	 *  the CPU sampler): findings that need them cannot appear, whatever the page does */
	unmeasured: string[];
}

/** The page's testing engine that answered: it ships with the SITE's build, so it can be older than this
 *  package (`version` 1: 0.8.2, before keys, navigations, finding names and `counts.cls`). */
export interface OgygiaEngine {
	version: number;
	/** the page ran lean testing (`og_testing=lean`): the testing API and nothing else of devtools.
	 *  Absent from an engine before version 3 (it ran full devtools whatever the cookie said) */
	lean?: boolean;
}

export interface OgygiaHydrationReport {
	kind: 'hydration';
	measured: boolean;
	engine: OgygiaEngine;
	/** `key`: the instance — its `islandKey` attribute (the nearest, across shadow roots), else `Name#n`
	 *  in document order. Absent from an engine before version 2 (`compare` then tallies by name). */
	islands: {
		fp: string;
		key?: string;
		name: string;
		wake: string;
		status: HydrationStatus;
		reason: string;
		diff: HtmlDiff | null;
		/** when it began to wake and when it could answer, on the page's clock (ms from the document's
		 *  start; null if it has not woken) — which of a test's steps woke it. Absent before engine 2 */
		t0?: number | null;
		done?: number | null;
		/** a `changed` island whose only differences are attributes (the same elements and text: often a
		 *  custom element setting its own as it upgrades); false when text or elements differ. Engine 3 */
		attributesOnly?: boolean;
		/** with `attributesOnly`, each attribute that differs (`from` / `to` null: absent) */
		attributes?: { tag: string; name: string; from: string | null; to: string | null }[] | null;
		/** input landed on it while it hydrated (a pointer over it, a press, a key, focus): its DOM may
		 *  have answered that input, so a change is not only the render. Engine 3 */
		inputDuringHydration?: boolean;
		/** attribute changes `ignoreAttributes` left out: the island reads `clean` because of them */
		ignored?: { tag: string; name: string; from: string | null; to: string | null }[];
	}[];
}

export type OgygiaSessionReport = Omit<SessionReport, 'findings' | 'counts'> & {
	kind: 'session';
	engine: OgygiaEngine;
	/** `cls` is absent from an engine before version 2 */
	counts: Omit<SessionReport['counts'], 'cls'> & { cls?: number };
	/** each with the islands it points at, by name (empty from an engine before version 2) */
	findings: (SessionReport['findings'][number] & { names: string[] })[];
	/** with `record(actions, { blockNavigation: true })`: the documents the page tried to load — the list to
	 *  count and compare (each is also a `navigation-blocked` finding, which `compare` leaves out). `after`:
	 *  what started it — its link or form, or the input being handled when it began; `approx` when that
	 *  could not be seen (no Navigation API in this browser, or an engine before version 2: then only
	 *  `url` and `t`) and `after` is the last input before it */
	navigations: {
		url: string;
		t: number | null;
		after: string | null;
		island: string | null;
		approx: boolean;
	}[];
	timeline: unknown[];
	/** what the test's browser cannot measure (see OgygiaPageReport) */
	unmeasured: string[];
	/** with `record(actions, { server: true })`: the server over the same stretch — its CPU across
	 *  every request the actions made, their outbound calls, the requests (the profiler's window). On a
	 *  serverless deployment with a profiler store, `requests` come from every instance (`instances`),
	 *  each with its own `cpu_ms`; the CPU profile is the starting instance's. `{ error }` when the window
	 *  could not run: the session report is still whole */
	server?:
		| (OgygiaProfileReport & {
				error?: undefined;
				window: {
					ms: number;
					requests: {
						method: string;
						path: string;
						route: string | null;
						ms: number;
						status: number | null;
						cpu_ms?: number;
						net_ms?: number | null;
						instance?: string;
					}[];
					instances?: number;
				};
		  })
		| { error: string; window?: undefined };
};

/** The profiler's JSON answer (`/__profiler/page?format=json`), the fields a test reads first typed. */
export interface OgygiaProfileReport {
	kind: 'profile';
	/** the ogygia that produced it (the page reports' `engine.version`): a profiler from before 3 sends
	 *  none — its findings are 0.8.2's, so compare profiles only across one version */
	engine?: { version: number };
	id: string;
	target: { page: string; runs: number[] };
	score: {
		score: number;
		grade: string;
		categories: { key: string; label: string; score: number; value: string; lost?: number }[];
		missing: { key: string; label: string; why: string }[];
	} | null;
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

export type OgygiaReport =
	| OgygiaPageReport
	| OgygiaHydrationReport
	| OgygiaSessionReport
	| OgygiaProfileReport;

// ── the driver: whatever runs your browser ──

/**
 * What ogygia needs from a page driver. Playwright's `Page` fits as is (`withOgygia` wires it);
 * Puppeteer's too (`evaluate`, and `fetch` for the profiler).
 */
export interface OgygiaDriver {
	/** run `fn(arg)` in the page and return its (JSON) result. Loosely typed (`unknown` in, `unknown`
	 *  out, and a method, so its parameters compare both ways), so `page.evaluate` of any driver fits
	 *  without a cast */
	evaluate(fn: (arg: unknown) => unknown, arg?: unknown): Promise<unknown>;
	/** GET a URL relative to the app (for `profile()`); default: `fetch` inside the page */
	get?(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
	/** POST to a URL relative to the app (the server window of `record(…, { server: true })`);
	 *  default: `fetch` inside the page */
	post?(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
	/** wait `ms` (default: a timer) */
	wait?(ms: number): Promise<void>;
	/** start holding back the page's document loads (answer them 204, so the page stays) for
	 *  `record(…, { blockNavigation: true })`; `stop()` ends it and lists them, `t` on the page's clock */
	blockNavigation?(): Promise<{ stop(): Promise<{ url: string; t: number | null }[]> }>;
	/** add `header: value` to every request the page makes to its own origin until the returned
	 *  function is called — the server window's id, so each instance of a serverless deployment
	 *  attributes the session's requests (`record(…, { server: true })`) */
	tagRequests?(header: string, value: string): Promise<() => Promise<void>>;
}

export interface OgygiaOptions {
	/** the profiler's key, for `profile()` on a build (a dev server needs none) */
	profilerKey?: string;
	/** where the profiler is mounted (default `/__profiler`) */
	profilerBase?: string;
	/** how long to wait for the page's testing API (default 15 s) */
	timeout?: number;
	/** the attribute that names an island INSTANCE in `hydration()` (on the island or an ancestor: an id
	 *  your app renders, e.g. a CMS block's). Without it, or where it is missing: `Name#n` */
	islandKey?: string;
	/** attribute changes `hydration()` leaves out: an island whose every difference matches reads
	 *  `clean` (with what it ignored in `ignored`). Each rule: the element's tag, the attribute's name,
	 *  its new value (or old, when removed) — a string matches exactly, a RegExp by test. E.g. web
	 *  components setting their own as they upgrade:
	 *  `[{ tag: /^qds-/, name: /^(tabindex|aria-)/ }, { name: 'style', value: '' }]` */
	ignoreAttributes?: { tag?: string | RegExp; name: string | RegExp; value?: string | RegExp }[];
	/** how many of the page load's hottest functions `page().cpu.fns` keeps (default 15, up to 500) */
	cpuFunctions?: number;
}

/** A pattern as it crosses into the page: a RegExp as its source and flags. */
const wire_pat = (p: string | RegExp | undefined) =>
	p instanceof RegExp ? { re: p.source, flags: p.flags } : p;

/** "Older engine" said once per site and version for the whole process (a CI run opens hundreds of pages). */
const warned_engines = new Set<string>();

export interface Ogygia {
	page(): Promise<OgygiaPageReport>;
	hydration(): Promise<OgygiaHydrationReport>;
	/** `server: true` also records the server over the same stretch (needs `devtools({ profiler })`, the devtools plugin's profiler).
	 *  `blockNavigation: true` holds back any document load the actions cause (a reload, a link), so the
	 *  page and the recording stay, and lists each in `navigations` (needs a driver that can: Playwright's) */
	record(
		actions: () => Promise<unknown>,
		opts?: { server?: boolean; blockNavigation?: boolean }
	): Promise<OgygiaSessionReport>;
	/** `fields`: only these top-level sections of the report (with what names it — schema, engine, id,
	 *  target, links), e.g. `['requests', 'network', 'findings', 'assets', 'summary']`: a full report is
	 *  hundreds of KB, mostly `stacks`, `hot_functions` and `drill` */
	profile(path: string, opts?: { runs?: number; fields?: string[] }): Promise<OgygiaProfileReport>;
	/** wait until no island is waking or hydrating */
	settled(opts?: { quiet?: number; timeout?: number }): Promise<boolean>;
	/** every report taken so far, in order */
	readonly reports: OgygiaReport[];
}

const NOT_THERE =
	"ogygia's testing API is not in this page. Serve the app with the devtools plugin listed beside ogygia() (`plugins: [ogygia(), devtools(), sveltekit()]`) " +
	'(the dev server, or a preview build) and open a csr = false page.';

/** The primitives over any driver. */
export function createOgygia(driver: OgygiaDriver, options: OgygiaOptions = {}): Ogygia {
	const wait = driver.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const reports: OgygiaReport[] = [];
	const keep = <T extends OgygiaReport>(r: T): T => (reports.push(r), r);
	// the page's engine version, from the last call (an older site's engine answers less)
	let engine: OgygiaEngine = { version: TESTING_ENGINE_VERSION };
	/** `driver.evaluate`, typed at the call site: `fn` goes to the driver as is (it runs in the
	 *  page), and its result comes back as `fn` returns it. */
	const in_page = <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> =>
		driver.evaluate(fn as (arg: unknown) => unknown, arg) as Promise<R>;
	const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
		const until = Date.now() + (options.timeout ?? 15_000);
		while (
			!(await in_page(() => !!(window as { __ogygia_testing?: unknown }).__ogygia_testing, null))
		) {
			if (Date.now() > until) throw new Error(NOT_THERE);
			await wait(100);
		}
		const out = (await in_page(
			async ([n, a]: readonly [string, unknown[]]) => {
				const t = (
					window as unknown as {
						__ogygia_testing: Record<string, (...x: unknown[]) => Promise<unknown>> & {
							version?: number;
						};
					}
				).__ogygia_testing;
				return { v: t.version ?? 1, r: await t[n](...a) };
			},
			[name, args] as const
		)) as { v: number; r: T };
		// (an engine from 3 on names itself, lean or not, in its reports)
		const own =
			out.r && typeof out.r === 'object' ? (out.r as { engine?: OgygiaEngine }).engine : undefined;
		engine = own ?? { version: out.v };
		if (out.v < TESTING_ENGINE_VERSION) {
			const at = await in_page(() => location.origin, null).catch(() => '');
			const key = `${at}|${out.v}`;
			if (warned_engines.has(key)) return out.r;
			warned_engines.add(key);
			console.warn(
				`[@ogygia/testing] the page${at ? ` at ${at}` : ''} runs an older testing engine (version ${out.v}, this package expects ${TESTING_ENGINE_VERSION}): ` +
					'its reports lack instance keys, finding names, counts.cls and what started each navigation. Filled in where the test side knows (navigations).'
			);
		}
		return out.r;
	};
	const get =
		driver.get ??
		((url: string, headers: Record<string, string>) =>
			in_page(
				async ([u, h]: readonly [string, Record<string, string>]) => {
					const r = await fetch(u, { headers: h });
					return { status: r.status, body: await r.text() };
				},
				[url, headers] as const
			));
	const post =
		driver.post ??
		((url: string, headers: Record<string, string>) =>
			in_page(
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
			const r = await call<Omit<OgygiaPageReport, 'kind'> | null>('page', options.cpuFunctions);
			if (!r)
				throw new Error(
					'the page load was not measured: in a build, devtools must be on in the browser (the `og_devtools=on` cookie, or `?og-devtools=on`) before the page loads'
				);
			return keep({ kind: 'page', ...r, engine });
		},
		async hydration() {
			await call('settled', 300, 10_000);
			const ignore = (options.ignoreAttributes ?? []).map((r) => ({
				tag: wire_pat(r.tag),
				name: wire_pat(r.name),
				value: wire_pat(r.value)
			}));
			const r = await call<Omit<OgygiaHydrationReport, 'kind' | 'engine'>>(
				'hydration',
				options.islandKey,
				ignore
			);
			return keep({ kind: 'hydration', ...r, engine });
		},
		async record(actions, ropts) {
			await call('settled', 300, 10_000);
			const b = options.profilerBase ?? '/__profiler';
			const headers = {
				accept: 'application/json',
				...(options.profilerKey ? { 'x-profiler-key': options.profilerKey } : {})
			};
			// the server window first (a 409: another recording holds the recorder — wait for it). A window
			// that cannot start leaves the session whole, with `server: { error }`
			let window_id: { header: string; id: string } | null = null;
			let untag: (() => Promise<void>) | null = null;
			let server_error: string | null = null;
			if (ropts?.server) {
				for (let tries = 0; ; tries++) {
					const s = await post(`${b}/window/start`, headers);
					if (s.status === 200) {
						const j = JSON.parse(s.body) as { id?: string; header?: string };
						if (j.id && j.header) window_id = { header: j.header, id: j.id };
						break;
					}
					if (s.status !== 409 || tries >= 30) {
						server_error = `the profiler could not start a window (${s.status}): ${s.body.slice(0, 200)}`;
						break;
					}
					await wait(2000);
				}
				// each request of the session carries the window's id, so every instance of a serverless
				// deployment attributes it (the profiler gathers them from its store at stop)
				if (window_id && driver.tagRequests)
					untag = await driver.tagRequests(window_id.header, window_id.id);
			}
			if (ropts?.blockNavigation && !driver.blockNavigation)
				throw new Error(
					'record(…, { blockNavigation: true }) needs a driver with `blockNavigation()` (withOgygia’s Playwright driver has one)'
				);
			const blocker = ropts?.blockNavigation ? await driver.blockNavigation!() : null;
			await call('record_start');
			let failed = false;
			let failure: unknown;
			try {
				await actions();
				await wait(600); // the last entries (a paint, a late request) land
			} catch (e) {
				failed = true;
				failure = e;
			}
			const blocked = blocker ? await blocker.stop() : [];
			// The recording lives in the page. If the actions took it to another document that has no
			// testing API (another site, a page without devtools), it is gone: say THAT, with the actions'
			// own error as the cause — never the "serve with devtools" of a page that never had it.
			let r: Omit<OgygiaSessionReport, 'kind'> | null = null;
			let stop_error: unknown;
			try {
				r = await call<Omit<OgygiaSessionReport, 'kind'> | null>('record_stop', blocked);
			} catch (e) {
				stop_error = e;
			}
			let server: OgygiaSessionReport['server'];
			if (untag) await untag().catch(() => {});
			if (ropts?.server && !server_error) {
				const s = await post(`${b}/window/stop`, {
					...headers,
					...(window_id ? { [window_id.header]: window_id.id } : {})
				});
				if (s.status === 200) {
					const json = JSON.parse(s.body) as Record<string, unknown>;
					server = {
						...json,
						mode: json.kind,
						kind: 'profile'
					} as unknown as OgygiaSessionReport['server'];
				} else server_error = `the profiler's window failed (${s.status}): ${s.body.slice(0, 200)}`;
			}
			if (server_error)
				server = { error: server_error } as unknown as OgygiaSessionReport['server'];
			if (!r) {
				const now = await in_page(() => location.href, null).catch(() => null);
				throw new Error(
					'the recording was lost: the page went to another document while it ran' +
						(now ? ` (it is now at ${now})` : '') +
						(stop_error !== undefined
							? ', and that document has no ogygia testing API to finish it'
							: '') +
						(failed ? '. The actions failed too: see `cause`' : '') +
						'. To keep the page, record with `{ blockNavigation: true }`.',
					{ cause: failed ? failure : stop_error }
				);
			}
			if (failed) throw failure;
			// an older site's engine ignores what it is handed: fill in what the test side knows
			const old = r as Partial<OgygiaSessionReport> & Omit<OgygiaSessionReport, 'kind'>;
			const navigations =
				old.navigations ??
				blocked.map((n) => ({ url: n.url, t: n.t, after: null, island: null, approx: true }));
			const findings = old.findings.map((f) => ({ ...f, names: f.names ?? [] }));
			if (!old.navigations)
				for (const n of navigations)
					findings.push({
						code: 'navigation-blocked',
						severity: 'warn',
						message: `The page tried to load another document (${n.url}); it was blocked, so the recording kept going.`,
						refs: [],
						names: []
					});
			return keep({
				kind: 'session',
				...r,
				findings,
				navigations,
				engine,
				...(server ? { server } : {})
			});
		},
		async profile(path, opts) {
			const b = options.profilerBase ?? '/__profiler';
			const fields = opts?.fields?.length
				? `&fields=${encodeURIComponent(opts.fields.join(','))}`
				: '';
			const res = await get(
				`${b}/page?p=${encodeURIComponent(path)}&runs=${opts?.runs ?? 3}&format=json${fields}`,
				{
					accept: 'application/json',
					...(options.profilerKey ? { 'x-profiler-key': options.profilerKey } : {})
				}
			);
			if (res.status !== 200)
				throw new Error(
					`the profiler answered ${res.status} for ${path}: ${res.body.slice(0, 200)}`
				);
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
	/** lean testing (`og_testing=lean`): the page runs the testing API and nothing else of devtools —
	 *  no launcher, no dock, no event side-channel in its HTML — so what it loads is what a visitor's
	 *  loads, plus the testing engine. An older site's engine ignores it (`engine.lean` says which ran) */
	lean?: boolean;
};

/** A document load ogygia held back (`record(…, { blockNavigation: true })`), `t` on the page's clock. */
export interface HeldNavigation {
	url: string;
	t: number | null;
}

/**
 * The driver `withOgygia` builds, for a Playwright `Page` you hold yourself (several contexts in one
 * test, a custom fixture): `createOgygia(playwrightDriver(page, { baseURL }))`. `onNavigationHeld` is
 * called as each document load is held back, so you can note what your script was doing then.
 */
export function playwrightDriver(
	page: Page,
	opts: { baseURL?: string; onNavigationHeld?: (nav: HeldNavigation) => void } = {}
): OgygiaDriver {
	return {
		evaluate: (fn, arg) => page.evaluate(fn, arg),
		wait: (ms) => page.waitForTimeout(ms),
		async blockNavigation() {
			const held: HeldNavigation[] = [];
			// the page's clock, from its start (the page cannot be asked while a load waits on the route)
			const origin = await page.evaluate(() => performance.timeOrigin).catch(() => null);
			// a document load in the page's own frame: answered 204, so the browser keeps the page
			const hold = async (route: Route) => {
				const req = route.request();
				if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return route.fallback();
				const nav = { url: req.url(), t: origin === null ? null : Math.round(Date.now() - origin) };
				held.push(nav);
				opts.onNavigationHeld?.(nav);
				await route.fulfill({ status: 204 });
			};
			await page.route('**/*', hold);
			return {
				async stop() {
					await page.unroute('**/*', hold);
					return held;
				}
			};
		},
		async tagRequests(header, value) {
			const origin = opts.baseURL ? new URL(opts.baseURL).origin : new URL(page.url()).origin;
			// (the page's own origin only: a header on another site's request would make it preflight)
			const tag = async (route: Route) => {
				const req = route.request();
				if (!req.url().startsWith(origin + '/')) return route.fallback();
				await route.fallback({ headers: { ...(await req.allHeaders()), [header]: value } });
			};
			await page.route('**/*', tag);
			return async () => {
				await page.unroute('**/*', tag);
			};
		},
		async get(url, headers) {
			const r = await page.request.get(url, { headers, timeout: 120_000 });
			return { status: r.status(), body: await r.text() };
		},
		async post(url, headers) {
			// (an Origin header: a SvelteKit app refuses a cross-site POST without one)
			const origin = opts.baseURL ? new URL(opts.baseURL).origin : undefined;
			const r = await page.request.post(url, {
				headers: { ...headers, ...(origin ? { origin } : {}) },
				timeout: 120_000
			});
			return { status: r.status(), body: await r.text() };
		}
	};
}

/**
 * Turn devtools on for this page's browser context, so a build measures it from its first load (the
 * `og_devtools=on` cookie): for `baseURL`, or with none for the origin of the first page it opens, on
 * that very request (Playwright's route handlers run newest first, so the test's own still run after).
 */
export async function turnOnDevtools(
	page: Page,
	baseURL?: string,
	opts: { lean?: boolean } = {}
): Promise<void> {
	// `lean`: lean testing too (insights/switch.ts) — the testing API and nothing else of devtools
	const pairs = [
		{ name: DEVTOOLS_COOKIE, value: DEVTOOLS_ON },
		...(opts.lean ? [{ name: TESTING_COOKIE, value: TESTING_LEAN }] : [])
	];
	const cookie = pairs.map((p) => `${p.name}=${p.value}`).join('; ');
	if (baseURL) {
		await page.context().addCookies(pairs.map((p) => ({ ...p, url: baseURL })));
		return;
	}
	const first = async (route: Route) => {
		const req = route.request();
		if (
			!req.isNavigationRequest() ||
			req.frame() !== page.mainFrame() ||
			!(req.url().startsWith('http:') || req.url().startsWith('https:'))
		)
			return route.fallback();
		await page.unroute('**/*', first);
		await page.context().addCookies(pairs.map((p) => ({ ...p, url: new URL(req.url()).origin })));
		const headers = await req.allHeaders();
		await route.fallback({
			headers: { ...headers, cookie: headers.cookie ? `${headers.cookie}; ${cookie}` : cookie }
		});
	};
	await page.route('**/*', first);
}

/**
 * Your Playwright `test` with an `ogygia` fixture, and your `expect` with ogygia's matchers.
 * Options per project: `use: { ogygiaOptions: { profilerKey, attach: false } }`.
 */
export function withOgygia<
	TA extends PlaywrightTestArgs & PlaywrightTestOptions,
	WA extends PlaywrightWorkerArgs & PlaywrightWorkerOptions
>(
	test: TestType<TA, WA>,
	expect: Expect
): {
	test: TestType<TA & { ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions }, WA>;
	expect: Expect;
} {
	// (extended on Playwright's own base shape: its fixture types do not resolve through a generic)
	const base = test as unknown as TestType<
		PlaywrightTestArgs & PlaywrightTestOptions,
		PlaywrightWorkerArgs & PlaywrightWorkerOptions
	>;
	const extended = base.extend<{ ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions }>({
		ogygiaOptions: [{}, { option: true }],
		ogygia: async ({ page, baseURL, ogygiaOptions }, use, testInfo) => {
			await turnOnDevtools(page, baseURL, { lean: ogygiaOptions.lean });
			const o = createOgygia(playwrightDriver(page, { baseURL }), ogygiaOptions);
			await use(o);
			if (ogygiaOptions.attach !== false && o.reports.length)
				await testInfo.attach('ogygia.json', {
					body: JSON.stringify(
						{
							test: testInfo.titlePath.join(' › '),
							status: testInfo.status,
							reports: o.reports.map(forAttachment)
						},
						null,
						1
					),
					contentType: 'application/json'
				});
		}
	});
	return {
		test: extended as unknown as TestType<
			TA & { ogygia: Ogygia; ogygiaOptions: OgygiaTestOptions },
			WA
		>,
		expect: expect.extend(ogygiaMatchers) as unknown as Expect
	};
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
		assets: p.assets
			? {
					totals: p.assets.totals,
					missing: p.assets.missing,
					...(p.assets.files ? { files: p.assets.files } : {})
				}
			: null,
		links: p.links,
		...((p as { window?: unknown }).window ? { window: (p as { window?: unknown }).window } : {}),
		hot_functions: ((p as { hot_functions?: unknown[] }).hot_functions ?? []).slice(0, 10)
	});
	if (r.kind === 'profile') return slim_profile(r);
	if (r.kind === 'session' && r.server)
		return { ...r, server: 'error' in r.server ? r.server : slim_profile(r.server) };
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
export function checkBudget(
	r: OgygiaReport,
	b: Budget
): { key: string; measured: number | null; limit: number; ok: boolean }[] {
	const out: { key: string; measured: number | null; limit: number; ok: boolean }[] = [];
	const le = (key: string, v: number | null | undefined, limit: number | undefined) => {
		if (limit !== undefined)
			out.push({
				key,
				measured: v ?? null,
				limit,
				ok: v !== undefined && v !== null && v <= limit
			});
	};
	const ge = (key: string, v: number | null | undefined, limit: number | undefined) => {
		if (limit !== undefined)
			out.push({
				key,
				measured: v ?? null,
				limit,
				ok: v !== undefined && v !== null && v >= limit
			});
	};
	if (r.kind === 'page') {
		const vit = (k: string) => r.vitals.find((x) => x.key === k)?.value;
		le('lcp', vit('lcp'), b.lcp);
		le('fcp', vit('fcp'), b.fcp);
		le('cls', vit('cls'), b.cls);
		le('inp', vit('inp'), b.inp);
		le('ttfb', vit('ttfb'), b.ttfb);
		le('longTaskMs', r.longtask_ms, b.longTaskMs);
		le(
			'islandWakeMs',
			r.islands.length ? Math.max(...r.islands.map((i) => i.done - i.t0)) : 0,
			b.islandWakeMs
		);
	} else if (r.kind === 'session') {
		le(
			'maxInteractionMs',
			r.interactions.length ? Math.max(...r.interactions.map((i) => i.duration)) : 0,
			b.maxInteractionMs
		);
		le('slowInteractions', r.counts.slow, b.slowInteractions);
		le('errors', r.counts.errors, b.errors);
		le('cls', r.counts.cls, b.cls);
		le('longTaskMs', r.counts.longtask_ms, b.longTaskMs);
		le(
			'failedRequests',
			r.requests.filter((q) => q.status !== null && q.status >= 400).length,
			b.failedRequests
		);
		le(
			'serverBusyMs',
			(r.server as { summary?: { busy_ms?: number } } | undefined)?.summary?.busy_ms,
			b.serverBusyMs
		);
	} else if (r.kind === 'profile') {
		ge('score', r.score?.score, b.score);
		le('renderMs', r.target?.runs?.length ? median(r.target.runs) : null, b.renderMs);
		le('jsBytes', r.assets?.totals?.js, b.jsBytes);
	}
	return out;
}

/** What each matcher answers — the shape Playwright, Vitest and Jest all read. */
export interface MatcherResult {
	pass: boolean;
	name: string;
	message: () => string;
}

/** `expect.extend(ogygiaMatchers)` — Playwright, Vitest and Jest all take this shape. */
export const ogygiaMatchers = {
	/** No finding at or above `severity` (default: any), except the codes in `ignore`. */
	toHaveNoFindings(
		received: OgygiaReport,
		opts: { severity?: Severity; ignore?: string[] } = {}
	): MatcherResult {
		const min = SEV[opts.severity ?? 'info'];
		const list = (
			'findings' in received
				? (received.findings as { code: string; severity: string; message: string }[])
				: []
		).filter(
			(f) => (SEV[f.severity as Severity] ?? 0) >= min && !(opts.ignore ?? []).includes(f.code)
		);
		const pass = list.length === 0;
		return {
			pass,
			name: 'toHaveNoFindings',
			message: () =>
				pass
					? 'expected ogygia findings, found none'
					: `expected no ogygia findings${opts.severity ? ` at ${opts.severity} or above` : ''}, found ${list.length}:\n` +
						list.map((f) => `  - [${f.severity}] ${f.code}: ${f.message}`).join('\n')
		};
	},
	/** Every line of the budget met (see {@link Budget}: page, session and profile lines). */
	toMeetBudget(received: OgygiaReport, budget: Budget): MatcherResult {
		const bad = checkBudget(received, budget).filter((l) => !l.ok);
		return {
			pass: bad.length === 0,
			name: 'toMeetBudget',
			message: () =>
				bad.length
					? `ogygia budget missed (${received.kind}):\n` +
						bad
							.map((l) => `  - ${l.key}: ${l.measured ?? 'not measured'} (budget ${l.limit})`)
							.join('\n')
					: 'expected the ogygia budget to be missed, it was met'
		};
	},
	/** No island failed, recovered, or changed its markup on hydration (`allow` some statuses;
	 *  `allowAttributeChanges`: a change only in attributes passes; `allowInput`: a change in an island
	 *  that input landed on while it hydrated passes). */
	toHydrateCleanly(
		received: OgygiaReport,
		opts: { allow?: HydrationStatus[]; allowAttributeChanges?: boolean; allowInput?: boolean } = {}
	): MatcherResult {
		if (received.kind !== 'hydration')
			return {
				pass: false,
				name: 'toHydrateCleanly',
				message: () => 'toHydrateCleanly takes the report of ogygia.hydration()'
			};
		const allow = new Set<HydrationStatus>(['clean', 'asleep', ...(opts.allow ?? [])]);
		const bad = received.islands.filter(
			(i) =>
				!allow.has(i.status) &&
				!(
					i.status === 'changed' &&
					((opts.allowAttributeChanges && i.attributesOnly) ||
						(opts.allowInput && i.inputDuringHydration))
				)
		);
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
	namespace PlaywrightTest {
		interface Matchers<R> {
			toHaveNoFindings(opts?: { severity?: Severity; ignore?: string[] }): R;
			toMeetBudget(budget: Budget): R;
			toHydrateCleanly(opts?: {
				allow?: HydrationStatus[];
				allowAttributeChanges?: boolean;
				allowInput?: boolean;
			}): R;
		}
	}
}

// ── two runs side by side (a CI script: gather each run's `ogygia.json` attachments) ──

export type SessionMoveKey = 'errors' | 'shifts' | 'slow' | 'navigations' | 'cls';

export interface RunDiff {
	test: string;
	kind: OgygiaReport['kind'];
	score?: { base: number; head: number };
	renderMs?: { base: number; head: number };
	/** JS at start, base → head, and the files behind the move (new / grew / shrank / gone, known by
	 *  what they hold: hashed names change every build) */
	js?: { base: number; head: number; changes: string[] };
	findings: { added: string[]; fixed: string[] };
	/** islands that stopped / started hydrating cleanly, per instance (`key`) — `Name#2: clean → failed` */
	hydration?: { broke: string[]; fixed: string[] };
	/** a recorded session's counts that moved (medians when several runs): errors, unexpected shifts, slow
	 *  interactions, blocked navigations, its CLS */
	session?: { key: SessionMoveKey; base: number; head: number }[];
	/** page vitals that moved past the noise (see {@link CompareOptions}) */
	vitals?: { key: string; base: number; head: number }[];
}

/** How far a vital must move to count, both ways (a run's own noise): an absolute floor, and for timings
 *  a share of the base too — `{ lcp: 150 }` = 150 ms and 10 %. Defaults: lcp/fcp 150, ttfb 100, inp 50, cls 0.02. */
export interface CompareOptions {
	noise?: Partial<Record<'lcp' | 'fcp' | 'ttfb' | 'inp' | 'cls', number>>;
}

const NOISE = { lcp: 150, fcp: 150, ttfb: 100, inp: 50, cls: 0.02 } as const;
const GOOD_HYDRATION = new Set(['clean', 'asleep']);

/** Islands whose hydration got worse / better between two reports: by instance key, or (reports from
 *  before keys) by how many islands of each name ended in each status. */
function hydration_moves(
	base: OgygiaHydrationReport,
	head: OgygiaHydrationReport
): { broke: string[]; fixed: string[] } {
	const broke: string[] = [];
	const fixed: string[] = [];
	if (base.islands.every((i) => i.key) && head.islands.every((i) => i.key)) {
		const b = new Map(base.islands.map((i) => [i.key, i.status]));
		const h = new Map(head.islands.map((i) => [i.key, i.status]));
		for (const [key, hs] of h) {
			const bs = b.get(key);
			if (!GOOD_HYDRATION.has(hs) && (bs === undefined || GOOD_HYDRATION.has(bs)))
				broke.push(`${key}: ${bs ?? 'new'} → ${hs}`);
		}
		for (const [key, bs] of b) {
			const hs = h.get(key);
			if (!GOOD_HYDRATION.has(bs) && (hs === undefined || GOOD_HYDRATION.has(hs)))
				fixed.push(`${key}: ${bs} → ${hs ?? 'gone'}`);
		}
		return { broke, fixed };
	}
	const tally = (r: OgygiaHydrationReport) => {
		const m = new Map<string, number>();
		for (const i of r.islands)
			if (!GOOD_HYDRATION.has(i.status))
				m.set(`${i.name}: ${i.status}`, (m.get(`${i.name}: ${i.status}`) ?? 0) + 1);
		return m;
	};
	const b = tally(base);
	const h = tally(head);
	for (const [k, n] of h) if (n > (b.get(k) ?? 0)) broke.push(`${k} ×${n - (b.get(k) ?? 0)}`);
	for (const [k, n] of b) if (n > (h.get(k) ?? 0)) fixed.push(`${k} ×${n - (h.get(k) ?? 0)}`);
	return { broke, fixed };
}

/** One test's reports from one side: a single run (`reports`, an `ogygia.json` body) or several runs of it
 *  (`runs`) — see {@link compare}. */
export type CompareInput =
	| { test: string; reports: OgygiaReport[] }
	| { test: string; runs: OgygiaReport[][] };

const runs_of = (t: CompareInput | undefined): OgygiaReport[][] =>
	!t ? [] : 'runs' in t ? t.runs : [t.reports];

/** The `nth` report of `kind` in each run that has one. */
const slot = (runs: OgygiaReport[][], kind: OgygiaReport['kind'], nth: number): OgygiaReport[] =>
	runs.map((r) => r.filter((x) => x.kind === kind)[nth]).filter((x): x is OgygiaReport => !!x);

/** A finding's code and its line, the first time each code is seen. */
function finding_lines(reports: OgygiaReport[], skip: Set<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const r of reports)
		for (const f of ('findings' in r ? r.findings : []) as { code: string; message: string }[])
			if (!skip.has(f.code) && !out.has(f.code))
				out.set(f.code, `${f.code}: ${f.message.slice(0, 140)}`);
	return out;
}

/** How many of the runs carry a finding of each code. */
function finding_counts(reports: OgygiaReport[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of reports)
		for (const code of new Set(
			(('findings' in r ? r.findings : []) as { code: string }[]).map((f) => f.code)
		))
			out.set(code, (out.get(code) ?? 0) + 1);
	return out;
}

/** The runs' hydration as one report: each instance's most common status (keys), else the run with the
 *  median number of islands that did not hydrate cleanly. */
function hydration_consensus(reports: OgygiaHydrationReport[]): OgygiaHydrationReport {
	if (reports.length === 1) return reports[0];
	if (reports.every((r) => r.islands.every((i) => i.key))) {
		const by = new Map<
			string,
			{ island: OgygiaHydrationReport['islands'][number]; votes: Map<string, number> }
		>();
		for (const r of reports)
			for (const i of r.islands) {
				const e = by.get(i.key!) ?? { island: i, votes: new Map() };
				e.votes.set(i.status, (e.votes.get(i.status) ?? 0) + 1);
				by.set(i.key!, e);
			}
		const islands = [...by.values()].map(({ island, votes }) => ({
			...island,
			status: [...votes].sort((a, b) => b[1] - a[1])[0][0] as HydrationStatus
		}));
		return { ...reports[0], islands };
	}
	const bad = (r: OgygiaHydrationReport) =>
		r.islands.filter((i) => !GOOD_HYDRATION.has(i.status)).length;
	return [...reports].sort((a, b) => bad(a) - bad(b))[reports.length >> 1];
}

/** The session-only codes `compare` leaves to their own line: `navigation-blocked` IS `navigations`. */
const SESSION_LISTED = new Set(['navigation-blocked']);

/**
 * What changed between two runs of the same tests (each: the `ogygia.json` bodies, parsed).
 *
 * A test can carry several runs a side (`{ test, runs }`): real pages are noisy, and one run against one
 * run turns that noise into false regressions. Then
 * - **load** signals — page vitals and findings, hydration, the profile's score, render time and JS — are
 *   compared on the runs' median (a finding or a broken island counts when most runs have it);
 * - **session** signals — what a scripted session ran into: its findings, errors, shifts, slow
 *   interactions, blocked navigations — count only when EVERY head run has it and NO base run does (a
 *   count: when every head run is above every base run, or below), since they depend on the path the
 *   session happened to take.
 * One run a side is the same rules on a single sample.
 */
export function compare(
	baseRun: CompareInput[],
	headRun: CompareInput[],
	opts: CompareOptions = {}
): RunDiff[] {
	const noise = { ...NOISE, ...opts.noise };
	const out: RunDiff[] = [];
	for (const h of headRun) {
		const hruns = runs_of(h);
		const bruns = runs_of(baseRun.find((x) => x.test === h.test));
		const template = hruns[0] ?? [];
		template.forEach((first, i) => {
			const kind = first.kind;
			const nth = template.slice(0, i).filter((x) => x.kind === kind).length;
			const hs = slot(hruns, kind, nth);
			const bs = slot(bruns, kind, nth);
			const session = kind === 'session';
			const skip = session ? SESSION_LISTED : new Set<string>();
			// findings: a session's when in every head run and no base run; a load's by majority
			const hc = finding_counts(hs);
			const bc = finding_counts(bs);
			const present = (c: Map<string, number>, n: number, code: string) =>
				session ? (c.get(code) ?? 0) === n && n > 0 : (c.get(code) ?? 0) * 2 > n;
			const absent = (c: Map<string, number>, n: number, code: string) =>
				session ? !c.get(code) : !((c.get(code) ?? 0) * 2 > n);
			const hl = finding_lines(hs, skip);
			const bl = finding_lines(bs, skip);
			const d: RunDiff = {
				test: h.test,
				kind,
				findings: {
					added: [...hl]
						.filter(([code]) => present(hc, hs.length, code) && absent(bc, bs.length, code))
						.map(([, t]) => t),
					fixed: [...bl]
						.filter(([code]) => present(bc, bs.length, code) && absent(hc, hs.length, code))
						.map(([, t]) => t)
				}
			};
			if (!bs.length) {
				out.push(d);
				return;
			}
			if (kind === 'hydration') {
				const m = hydration_moves(
					hydration_consensus(bs as OgygiaHydrationReport[]),
					hydration_consensus(hs as OgygiaHydrationReport[])
				);
				if (m.broke.length || m.fixed.length) d.hydration = m;
			}
			if (session) {
				const value = (r: OgygiaReport, key: SessionMoveKey) =>
					key === 'navigations'
						? ((r as OgygiaSessionReport).navigations ?? []).length
						: (r as OgygiaSessionReport).counts[key];
				const moved: NonNullable<RunDiff['session']> = [];
				for (const key of ['errors', 'shifts', 'slow', 'navigations', 'cls'] as const) {
					const hv = hs.map((r) => value(r, key));
					const bv = bs.map((r) => value(r, key));
					// (an older site's engine has no `cls`: no line rather than a false one)
					if (hv.some((v) => v === undefined) || bv.some((v) => v === undefined)) continue;
					const hn = hv as number[];
					const bn = bv as number[];
					const apart = Math.min(...hn) > Math.max(...bn) || Math.max(...hn) < Math.min(...bn);
					const [hm, bm] = [median(hn), median(bn)];
					if (apart && (key !== 'cls' || Math.abs(hm - bm) >= noise.cls))
						moved.push({ key, base: bm, head: hm });
				}
				if (moved.length) d.session = moved;
			}
			if (kind === 'page') {
				const moved: { key: string; base: number; head: number }[] = [];
				for (const key of ['lcp', 'fcp', 'ttfb', 'inp', 'cls'] as const) {
					const pick = (rs: OgygiaReport[]) =>
						rs
							.map((r) => (r as OgygiaPageReport).vitals.find((v) => v.key === key)?.value)
							.filter((v): v is number => typeof v === 'number');
					const hv = pick(hs);
					const bv = pick(bs);
					if (!hv.length || !bv.length) continue;
					const [hm, bm] = [median(hv), median(bv)];
					const delta = Math.abs(hm - bm);
					if (key === 'cls' ? delta >= noise.cls : delta >= noise[key] && delta >= bm * 0.1)
						moved.push({ key, base: bm, head: hm });
				}
				if (moved.length) d.vitals = moved;
			}
			if (kind === 'profile') {
				const hp = hs as OgygiaProfileReport[];
				const bp = bs as OgygiaProfileReport[];
				const scores = (ps: OgygiaProfileReport[]) =>
					ps.map((p) => p.score?.score).filter((v): v is number => typeof v === 'number');
				if (scores(hp).length && scores(bp).length)
					d.score = { base: median(scores(bp)), head: median(scores(hp)) };
				const renders = (ps: OgygiaProfileReport[]) =>
					ps.filter((p) => p.target?.runs?.length).map((p) => median(p.target.runs));
				if (renders(hp).length && renders(bp).length)
					d.renderMs = { base: median(renders(bp)), head: median(renders(hp)) };
				// the files behind a JS move: the runs with the median JS each side
				const mid = (ps: OgygiaProfileReport[]) => {
					const w = ps
						.filter((p) => p.assets?.totals)
						.sort((a, b) => a.assets!.totals!.js - b.assets!.totals!.js);
					return w[w.length >> 1];
				};
				const br = mid(bp);
				const hr = mid(hp);
				const ba = br?.assets;
				const ha = hr?.assets;
				if (ba?.totals && ha?.totals && ba.files && ha.files) {
					const diff = assets_diff(
						{ assets: ba.files, totals: ba.totals },
						{ assets: ha.files, totals: ha.totals }
					);
					const kb = (n: number) => `${Math.round(n / 1024)} KB`;
					const what = (c: { name: string; contains?: string[] }) =>
						c.contains?.length ? c.contains.slice(0, 2).join(', ') : c.name;
					d.js = {
						base: ba.totals.js,
						head: ha.totals.js,
						changes: [
							...diff.added.map(
								(c) => `new ${what(c)} ${kb(c.b)}${c.lazy ? ' (loads later)' : ''}`
							),
							...diff.grew.map((c) => `grew ${what(c)} ${kb(c.a)} → ${kb(c.b)}`),
							...diff.shrank.map((c) => `shrank ${what(c)} ${kb(c.a)} → ${kb(c.b)}`),
							...diff.removed.map((c) => `gone ${what(c)} ${kb(c.a)}`),
							...diff.to_start.map(
								(c) => `now at start ${what(c)} ${kb(c.b)} (loaded later before)`
							),
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
			(d.js && (d.js.changes.length || Math.abs(d.js.head - d.js.base) >= 5 * 1024)) ||
			d.hydration ||
			d.session ||
			d.vitals
	);
	if (!moved.length) return '**ogygia**: no change in the measured tests.';
	const out = ['**ogygia**: what changed', ''];
	for (const d of moved) {
		out.push(`- **${d.test}** (${d.kind})`);
		if (d.score && d.score.base !== d.score.head)
			out.push(`  - score ${d.score.base} → ${d.score.head}`);
		if (d.renderMs && Math.abs(d.renderMs.head - d.renderMs.base) >= 5)
			out.push(
				`  - server render ${Math.round(d.renderMs.base)} → ${Math.round(d.renderMs.head)} ms`
			);
		if (d.js && (d.js.changes.length || Math.abs(d.js.head - d.js.base) >= 5 * 1024))
			out.push(
				`  - JS at start ${Math.round(d.js.base / 1024)} → ${Math.round(d.js.head / 1024)} KB${d.js.changes.length ? `: ${d.js.changes.join('; ')}` : ''}`
			);
		for (const v of d.vitals ?? [])
			out.push(
				`  - ${v.key.toUpperCase()} ${v.key === 'cls' ? v.base : Math.round(v.base) + ' ms'} → ${v.key === 'cls' ? v.head : Math.round(v.head) + ' ms'}`
			);
		for (const s of d.session ?? [])
			out.push(
				`  - ${s.key === 'cls' ? 'session CLS' : s.key === 'slow' ? 'slow interactions' : s.key === 'navigations' ? 'blocked navigations' : s.key} ${s.base} → ${s.head}`
			);
		for (const h of d.hydration?.broke ?? []) out.push(`  - hydration broke: ${h}`);
		for (const h of d.hydration?.fixed ?? []) out.push(`  - hydration fixed: ${h}`);
		for (const f of d.findings.added) out.push(`  - new: ${f}`);
		for (const f of d.findings.fixed) out.push(`  - fixed: ${f}`);
	}
	return out.join('\n');
}
