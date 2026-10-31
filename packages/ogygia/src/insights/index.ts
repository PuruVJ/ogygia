/**
 * `ogygia/insights` — the analysis engine shared by the devtools dock, the profiler's report and
 * `ogygia/testing`: pure functions from what the browser measured (a page visit, a recorded session)
 * to findings, plus the switch cookies and the testing engine's version they agree on.
 */
export {
	analyze_page,
	type PageInput,
	type RegionFact,
	type PageReport,
	type PageFinding,
	type RatedVital,
	type IslandRow
} from './page-insights.ts';

export { analyze_session, type SessionFinding, type SessionReport } from './session-insights.ts';
export type { SessionData } from './session-data.ts';
export type { HydrationStatus } from './hydration-status.ts';
export { html_diff, type HtmlDiff } from './html-diff.ts';
export { assets_diff, type AssetsDiff } from './page-assets.ts';

export {
	DEVTOOLS_COOKIE,
	DEVTOOLS_ON,
	DEVTOOLS_PARAM,
	TESTING_COOKIE,
	TESTING_LEAN,
	TESTING_PARAM
} from './switch.ts';
export { TESTING_ENGINE_VERSION } from './testing-version.ts';
