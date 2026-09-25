/**
 * The profiler's route tree — dogfood for `ogygia/router` v2 (internal/notes/router-v2.md). Extracted
 * from ProfilerHost so its `$infer` type is importable: the host passes bound methods across the typed
 * `ProfilerDeps` boundary, and each UI component types its props by indexing the map —
 * `let { data }: ProfilerRoutes['/'] = $props()` — instead of re-declaring the shape.
 *
 * v2 idioms on show: a flat table (the whole sitemap in one glance), the auth GUARD as the table-wide
 * `load` (no chrome component — the profiler pages render their own Shell), a root `error` boundary,
 * bare `{ GET }` endpoint objects, and thrown `error()` for the expired-report 404s.
 *
 * The one unavoidable ceremony is `V` below: each UI component types its props by indexing
 * `ProfilerRoutes` (`ProfilerRoutes['/']`), so referencing a component VALUE here — while `$infer`
 * (hence `ProfilerRoutes`) is still being computed — makes svelte2tsx resolve that component's own
 * props mid-computation and report `$$ComponentProps circularly references itself` (props then fall
 * back to `any`, silently). Erasing the refs to a bare `Component` record breaks the self-reference;
 * `$infer` still comes from the LOADS, which keep their real return types. This is the same reason Kit
 * generates `./$types` in a component-free module — a programmatic router has no codegen to hide it.
 */
// The PUBLIC self-reference spec (like ogygia/internal), not '../router/index.js': the prescan
// spots router modules by the literal 'ogygia/router' import, and THAT is what makes this module's
// page components router-css roots with no hand-seeding (the old extra_router_modules special case).
// Same module either way — the svelte export condition resolves it back into this build's source.
import { routes, page, error, type Ctx } from 'ogygia/router';
import type { AnyComponent } from '../router/define.js';
import type { Analysis } from './analyze.js';
import type { ReportExtras, ReportMeta, RequestEntry, RouteAgg } from './report.js';
// Type-only (erased) — index.ts value-imports THIS module, so a value import back would cycle.
import type { StoredReport, SampledSummary, TrapStatus } from './index.js';
import Dashboard from './ui/Dashboard.svelte';
import Report from './ui/Report.svelte';
import Run from './ui/Run.svelte';
import Login from './ui/Login.svelte';
import Upload from './ui/Upload.svelte';
import Message from './ui/Message.svelte';
import Compare from './ui/Compare.svelte';
import Site from './ui/Site.svelte';
import type { Comparison } from './compare.js';
import type { SinkRow } from './sink.js';

/** Prop-erased component refs — see the file header. Referenced as `V.Dashboard` in the table so
 *  `$infer` never resolves a component's own (self-referential) props. Real types survive on `data`. */
const V = { Dashboard, Report, Run, Login, Upload, Message, Compare, Site } as unknown as Record<
	string,
	AnyComponent
>;

/** One page's profile history: every page-mode report of it, oldest first, by median run. */
export interface PageHistory {
	page: string;
	points: { id: string; created: number; median: number }[];
}

/** What the router calls into the host for. Return types here ARE the components' `data` types. */
export interface ProfilerDeps {
	base: string;
	/** Table-wide guard: a deny Response short-circuits every route (v2 load-returns-Response), else
	 *  `undefined` = allow. The load below turns allow into the seeded `{ base }`. */
	auth_guard(c: Ctx): Promise<Response | undefined>;
	/** The runtime's hydration beacon (POST, authed): browser-side island timings, joined by fingerprint. */
	beacon(c: Ctx): Promise<Response>;
	/** Is this request logged in? The public bare report page gates its SERVER data on this (a share
	 *  `#fragment` renders without it). */
	authed(c: Ctx): Promise<boolean>;
	dashboard(c: Ctx): {
		base: string;
		recent: RequestEntry[];
		routes: RouteAgg[];
		/** the request tag the slowest-routes table is split by (`?by=tenant`), when any */
		by: string | null;
		/** every tag key seen in the log (`tag()`), for the split-by control */
		tag_keys: string[];
		reports: ReportMeta[];
		recording: boolean;
		dev: boolean;
		rss_mb: number;
		inflight: number;
		/** page-mode reports grouped by page (the history sparklines + compare pairs) */
		history: PageHistory[];
		/** the trap (catch the slow one), when configured */
		trap: TrapStatus | null;
		/** the always-on sampler's rolling hot-functions table, when configured */
		sampled: SampledSummary | null;
		/** why the background recorders are off (a serverless host), when they are */
		background_note: string | null;
	};
	/** Two stored reports side by side (404 when either expired). */
	/** `cmp` is null when this server no longer holds one of the reports: the page then compares
	 *  from the browser's store (the ids come back so it can) */
	compare(a: string | undefined, b: string | undefined): { base: string; cmp: Comparison | null; a: string; b: string };
	/** the whole-site pictures: this instance's rows, the sink's status, a URL the browser reads rows from */
	site(c: Ctx): { base: string; rows: SinkRow[]; sink: { url: string; last: { at: number; ok: boolean; rows: number; error?: string } | null; buffered: number } | null; from: string | null; ephemeral: boolean };
	/** A caught request profiled again in full page mode with the inputs it was caught with. */
	replay(id: string | undefined, c: Ctx): Promise<Response>;
	/** DEV ONLY: a few lines of a local source file around a line (the row's source peek). */
	source(c: Ctx): Promise<Response>;
	run_page(c: Ctx): Response | { base: string; path: string; runs: number; format: string };
	record_page(c: Ctx): Promise<Response>;
	reset(c: Ctx): Response;
	/** A tiny live-status poll for the sidebar (and, later, a hosted dashboard): is a recording
	 *  running right now, how many requests are in flight, the instance's memory, how many reports
	 *  this instance holds. Cheap and side-effect-free. */
	status(c: Ctx): { recording: boolean; inflight: number; rss_mb: number; reports: number };
	/** `session_problem`: why a login that just succeeded still has no session (null otherwise). */
	login_props(c: Ctx): { base: string; next: string; session_problem: string | null };
	login(c: Ctx): Promise<Response>;
	logout(c: Ctx): Response;
	upload(c: Ctx): Promise<Response>;
	report_stored(id: string | undefined): StoredReport | undefined;
	/** Like `report_stored`, but falls through to the configured storage backend (SQLite/Redis/
	 *  Postgres) on a memory miss and reconstructs the report from its stored dump — so a report
	 *  survives the instance that made it. Memory-only when no store is configured. */
	report_load(id: string | undefined): Promise<StoredReport | undefined>;
	/** The reports the backend holds (summaries), for the sidebar's shared list. Empty with no store. */
	list_stored(limit?: number): Promise<{ id: string; label: string; page?: string; created: number }[]>;
	/** The login page for THIS url (`?next=` back here) when the UI is secret-gated; null when a
	 *  login makes no sense (dev is open; no secret = no UI). */
	login_url(c: Ctx): string | null;
	report_view(stored: StoredReport): Promise<{
		a: Analysis;
		meta: ReportMeta;
		base: string;
		extras: ReportExtras;
		ogpB64?: string;
		/** this page's other page-mode reports (page mode only) and the one just before this */
		history: PageHistory | null;
		prev: string | null;
		/** recorded on a dev server — the source peek is available */
		dev: boolean;
	}>;
	report_json(stored: StoredReport): Response;
	report_dump_json(stored: StoredReport): Response;
	/** ONE self-contained HTML file of the report (styles, runtime and island chunks inlined) —
	 *  opens from disk with the islands live. A built app only; dev answers 400. */
	report_html(stored: StoredReport, c: Ctx): Promise<Response>;
	report_raw(stored: StoredReport): Promise<Response>;
}

/** Shared lookup for the report representations: the stored report (memory or the storage backend),
 *  or a thrown 404. */
async function report_or_404<R>(d: ProfilerDeps, id: string | undefined, fn: (s: StoredReport) => R): Promise<Awaited<R>> {
	const s = await d.report_load(id);
	if (!s) error(404, 'That report has expired.');
	return await fn(s);
}

/** Build the profiler router. Auth is the table-wide `load` (a redirect/deny short-circuits every
 *  route; on allow it seeds `{ base }`); thrown `error()` renders the root `Message` boundary.
 *  `/report/[id]` is PUBLIC (a share `#fragment` decrypts client-side); its `.json`/`.dump`/`/raw`
 *  siblings keep the suffix so they stay behind the guard's server-data gate. Endpoints are
 *  the plain `{ GET }` object form (bare handlers; `c.params.id` reads from the table key). */
export function build_profiler_router(d: ProfilerDeps) {
	return routes(
		{
			'/': page(V.Dashboard, { load: (c) => d.dashboard(c) }),
			'/run': page(V.Run, { load: (c) => d.run_page(c) }),
			'/page': { GET: (c) => d.record_page(c) },
			'/reset': { GET: (c) => d.reset(c) },
			'/status.json': { GET: (c) => c.json(d.status(c)) },
			// the browser's hydration timings (runtime/beacon.ts) — behind the guard like everything else
			'/beacon': { POST: (c) => d.beacon(c) },
			'/login': page(V.Login, {
				load: (c) => d.login_props(c),
				actions: { default: (c) => d.login(c) }
			}),
			'/logout': { GET: (c) => d.logout(c) },
			'/view': page(V.Upload, {
				load: () => ({ base: d.base }),
				actions: { default: (c) => d.upload(c) }
			}),
			// The bare report page renders from EITHER the server report (logged in only — else an unauth
			// visitor could read reports by guessing the id) OR a share-link `#fragment` (client-side).
			'/reports.json': { GET: async (c) => c.json(await d.list_stored()) },
			'/report/[id]': page(V.Report, {
				load: async (c) => {
					const stored = (await d.authed(c)) ? await d.report_load(c.params.id) : d.report_stored(c.params.id);
					if (stored && (await d.authed(c)))
						return { report: await d.report_view(stored), base: d.base, login: null, exists: true };
					// Not logged in (or no such report): the page renders the share-link gate. When this
					// server HAS the report, say so and offer the login — the visitor is most likely its
					// owner on a fresh browser, not a share-link recipient.
					return { report: null, base: d.base, login: d.login_url(c), exists: !!stored };
				}
			}),
			'/report/[id].json': {
				GET: (c) => report_or_404(d, c.params.id, d.report_json)
			},
			'/report/[id].html': {
				GET: (c) => report_or_404(d, c.params.id, (s) => d.report_html(s, c))
			},
			'/report/[id].dump': {
				GET: (c) => report_or_404(d, c.params.id, d.report_dump_json)
			},
			'/report/[id]/raw': {
				GET: (c) => report_or_404(d, c.params.id, d.report_raw)
			},
			// Before/after: two stored reports, deltas signed so a regression reads positive.
			'/compare/[a]/[b]': page(V.Compare, { load: (c) => d.compare(c.params.a, c.params.b) }),
			// profile a caught request again, in full page mode, with the inputs it was caught with
			'/replay/[id]': { GET: (c) => d.replay(c.params.id, c) },
			// the whole site: the request cloud and the layer cake, from this instance or a sink
			'/site': page(V.Site, { load: (c) => d.site(c) }),
			// The source peek behind an expanded row (dev only; 404 elsewhere).
			'/source': { GET: (c) => d.source(c) }
		},
		{
			base: d.base,
			error: V.Message,
			load: async (c) => (await d.auth_guard(c)) ?? { base: d.base },
			miss: () => error(404, 'Unknown profiler page.')
		}
	);
}

/** The whole profiler route tree as a typed `path → { data, params, form, search }` map — components index it. */
export type ProfilerRoutes = ReturnType<typeof build_profiler_router>['$infer'];
