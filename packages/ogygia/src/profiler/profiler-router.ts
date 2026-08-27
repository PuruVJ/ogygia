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
import { routes, page, error, type Ctx } from '../router/index.js';
import type { AnyComponent } from '../router/define.js';
import type { Analysis } from './analyze.js';
import type { ReportExtras, ReportMeta, RequestEntry, RouteAgg } from './report.js';
// Type-only (erased) — index.ts value-imports THIS module, so a value import back would cycle.
import type { StoredReport } from './index.js';
import Dashboard from './ui/Dashboard.svelte';
import Report from './ui/Report.svelte';
import Run from './ui/Run.svelte';
import Login from './ui/Login.svelte';
import Upload from './ui/Upload.svelte';
import Message from './ui/Message.svelte';

/** Prop-erased component refs — see the file header. Referenced as `V.Dashboard` in the table so
 *  `$infer` never resolves a component's own (self-referential) props. Real types survive on `data`. */
const V = { Dashboard, Report, Run, Login, Upload, Message } as unknown as Record<
	string,
	AnyComponent
>;

/** What the router calls into the host for. Return types here ARE the components' `data` types. */
export interface ProfilerDeps {
	base: string;
	/** Table-wide guard: a deny Response short-circuits every route (v2 load-returns-Response), else
	 *  `undefined` = allow. The load below turns allow into the seeded `{ base }`. */
	auth_guard(c: Ctx): Promise<Response | undefined>;
	/** Is this request logged in? The public bare report page gates its SERVER data on this (a share
	 *  `#fragment` renders without it). */
	authed(c: Ctx): Promise<boolean>;
	dashboard(): {
		base: string;
		recent: RequestEntry[];
		routes: RouteAgg[];
		reports: ReportMeta[];
		recording: boolean;
		dev: boolean;
		rss_mb: number;
		inflight: number;
	};
	run_page(c: Ctx): Response | { base: string; path: string; runs: number; format: string };
	record_page(c: Ctx): Promise<Response>;
	reset(c: Ctx): Response;
	login_props(c: Ctx): { base: string; next: string };
	login(c: Ctx): Promise<Response>;
	logout(c: Ctx): Response;
	upload(c: Ctx): Promise<Response>;
	report_stored(id: string | undefined): StoredReport | undefined;
	report_view(
		stored: StoredReport
	): Promise<{
		a: Analysis;
		meta: ReportMeta;
		base: string;
		extras: ReportExtras;
		ogpB64?: string;
	}>;
	report_json(stored: StoredReport): Response;
	report_dump_json(stored: StoredReport): Response;
	report_raw(stored: StoredReport): Promise<Response>;
}

/** Shared lookup for the report representations: the stored report, or a thrown 404. */
function report_or_404<R>(d: ProfilerDeps, id: string | undefined, fn: (s: StoredReport) => R): R {
	const s = d.report_stored(id);
	if (!s) error(404, 'That report has expired.');
	return fn(s);
}

/** Build the profiler router. Auth is the table-wide `load` (a redirect/deny short-circuits every
 *  route; on allow it seeds `{ base }`); thrown `error()` renders the root `Message` boundary.
 *  `/report/[id]` is PUBLIC (a share `#fragment` decrypts client-side); its `.json`/`.dump`/`/raw`
 *  siblings keep the suffix so they stay behind the guard's server-data gate. Endpoints are
 *  the plain `{ GET }` object form (bare handlers; `c.params.id` reads from the table key). */
export function build_profiler_router(d: ProfilerDeps) {
	return routes(
		{
			'/': page(V.Dashboard, { load: () => d.dashboard() }),
			'/run': page(V.Run, { load: (c) => d.run_page(c) }),
			'/page': { GET: (c) => d.record_page(c) },
			'/reset': { GET: (c) => d.reset(c) },
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
			'/report/[id]': page(V.Report, {
				load: async (c) => {
					const stored = d.report_stored(c.params.id);
					return stored && (await d.authed(c))
						? { report: await d.report_view(stored), base: d.base }
						: { report: null, base: d.base };
				}
			}),
			'/report/[id].json': {
				GET: (c) => report_or_404(d, c.params.id, d.report_json)
			},
			'/report/[id].dump': {
				GET: (c) => report_or_404(d, c.params.id, d.report_dump_json)
			},
			'/report/[id]/raw': {
				GET: (c) => report_or_404(d, c.params.id, d.report_raw)
			}
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
