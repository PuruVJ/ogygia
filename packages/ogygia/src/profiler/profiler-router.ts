/**
 * The profiler's route tree, extracted from ProfilerHost so its `$infer` type is importable.
 *
 * The host's handlers are private, so the router can't live in the class AND be type-extractable. Here
 * it takes a typed `ProfilerDeps` boundary (the host passes bound methods); the handler return types
 * flow into `$infer`, which we export as `ProfilerRoutes`. Each UI component then types its props by
 * indexing it — `let { data }: ProfilerRoutes['/'] = $props()` — instead of re-declaring the shape.
 */
import type { Component } from 'svelte';
import { routes, type Ctx } from '../router/index.js';
import type { Analysis } from './analyze.js';
import type { ReportExtras, ReportMeta, RequestEntry, RouteAgg } from './report.js';
// Type-only (erased at runtime) — index.ts value-imports THIS module, so a value import back would
// cycle, but a type import is fine and lets the report views carry the real StoredReport type.
import type { StoredReport } from './index.js';
import Dashboard from './ui/Dashboard.svelte';
import Report from './ui/Report.svelte';
import Run from './ui/Run.svelte';
import Login from './ui/Login.svelte';
import Upload from './ui/Upload.svelte';
import Message from './ui/Message.svelte';

// Prop-erased component references. `ProfilerRoutes` (this module's `$infer`) is what the components
// type their props with, so the router's TYPE must NOT depend on those components' prop types — else
// `component ← ProfilerRoutes ← this router ← component` is a cycle. The router never uses the prop
// types (r.page erases them); this cast just stops TS resolving them while computing $infer. Kit dodges
// the same cycle by generating $types in a separate file that never imports the components.
const P = { Dashboard, Report, Run, Login, Upload, Message } as unknown as Record<
	'Dashboard' | 'Report' | 'Run' | 'Login' | 'Upload' | 'Message',
	Component<Record<string, unknown>>
>;

/** What the router calls into the host for. Return types here ARE the components' `data` types. */
export interface ProfilerDeps {
	base: string;
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
	): Promise<{ a: Analysis; meta: ReportMeta; base: string; extras: ReportExtras; ogpB64?: string }>;
	report_json(stored: StoredReport): Response;
	report_dump_json(stored: StoredReport): Response;
	report_raw(stored: StoredReport): Promise<Response>;
}

/** Build the profiler router. Auth is the top layer load (Kit-idiomatic — a redirect/404 short-circuits
 *  every page below it); on allow it seeds `base` so pages and the error boundary can link home. Every
 *  `c.error()` renders the `Message` boundary. The report page and its `.json`/`/raw` views nest under
 *  `/report/[id]` and share ONE lookup load (fetch + 404 once; the children reuse `c.data.stored`). */
export function build_profiler_router(d: ProfilerDeps) {
	return routes(
		(r) =>
			r
				.load(async (c) => (await d.auth_guard(c)) ?? { base: d.base })
				.error(P.Message)
				.routes({
					'/': (r) => r.page(P.Dashboard).load(() => d.dashboard()),
					'/run': (r) => r.page(P.Run).load((c) => d.run_page(c)),
					'/page': (r) => r.GET((c) => d.record_page(c)),
					'/reset': (r) => r.GET((c) => d.reset(c)),
					'/login': (r) =>
						r.page(P.Login).load((c) => d.login_props(c)).action((c) => d.login(c)),
					'/logout': (r) => r.GET((c) => d.logout(c)),
					'/view': (r) => r.page(P.Upload).load(() => ({ base: d.base })).action((c) => d.upload(c)),
					// ONE report view. The bare `/report/[id]` page is PUBLIC (see auth_guard) and renders via
					// `Report` → `ReportBody` from EITHER: the server report (only when logged in — else an
					// unauth visitor could read reports by guessing the short id), OR a share-link `#fragment`
					// decrypted client-side (public, zero-knowledge). No shared layer load — that would
					// serialize `stored` to the client and leak it; each child looks it up itself. `.json` /
					// `.dump` / `.raw` keep the `.`/`/raw` suffix so they stay behind auth (id-guess safe).
					'/report/[id]': (r) =>
						r.routes({
							'/': (r) =>
								r.page(P.Report).load(async (c) => {
									const stored = d.report_stored(c.params.id);
									return stored && (await d.authed(c))
										? { report: await d.report_view(stored), base: d.base }
										: { report: null, base: d.base };
								}),
							'.json': (r) =>
								r.GET((c) => {
									const s = d.report_stored(c.params.id);
									return s ? d.report_json(s) : c.error(404, 'That report has expired.');
								}),
							'.dump': (r) =>
								r.GET((c) => {
									const s = d.report_stored(c.params.id);
									return s ? d.report_dump_json(s) : c.error(404, 'That report has expired.');
								}),
							'/raw': (r) =>
								r.GET((c) => {
									const s = d.report_stored(c.params.id);
									return s ? d.report_raw(s) : c.error(404, 'That report has expired.');
								})
						})
				}),
		{ base: d.base, miss: (c) => c.error(404, 'Unknown profiler page.') }
	);
}

/** The whole profiler route tree as a typed `path → { data, params, form }` map — components index it. */
export type ProfilerRoutes = ReturnType<typeof build_profiler_router>['$infer'];
