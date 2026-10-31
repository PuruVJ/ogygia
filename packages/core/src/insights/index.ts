/**
 * `ogygia/insights` — the analysis engine shared by the devtools dock, the profiler's report and
 * `@ogygia/testing`: pure functions from what the browser measured (a page visit, a recorded session)
 * to findings, plus the switch cookies and the testing engine's version they agree on.
 */
export {
	analyze_page,
	browser_of,
	defer_keys,
	dev_compile_ms,
	engine_of,
	explain_held_open,
	first_difference,
	inline_threshold_tune,
	late_found,
	lcp_font,
	lcp_rivals,
	prebundled_names,
	rate,
	vital_parts,
	vitals_moved,
	DOM_LARGE,
	type PageInput,
	type RegionFact,
	type PageReport,
	type PageFinding,
	type RatedVital,
	type IslandRow,
	type Failure,
	type HeldOpen,
	type HoleBatch,
	type HoleFailure,
	type HoleWait,
	type InteractionCpuInput,
	type IslandCode,
	type NavPhases,
	type PageInteraction,
	type PageNav,
	type PartedVital,
	type RestoreEvent,
	type ServerProfileBrief,
	type VitalMove,
	type VitalPart
} from './page-insights.ts';

export {
	analyze_session,
	session_timeline,
	type Ref,
	type SessionFinding,
	type SessionReport,
	type TimelineItem,
	type TimelineLane
} from './session-insights.ts';
export type {
	SessionData,
	SessionClick,
	SessionFrame,
	SessionInteraction,
	SessionNav,
	SessionRequest,
	SessionShift
} from './session-data.ts';
export type { HydrationStatus } from './hydration-status.ts';
export { html_diff, type HtmlDiff } from './html-diff.ts';
export {
	assets_diff,
	dynamic_imports,
	runtime_scripts,
	static_imports,
	weigh_assets,
	type AssetKind,
	type AssetRef,
	type AssetsDiff,
	type PageAssets,
	type RuntimeScripts,
	type Weight
} from './page-assets.ts';
export { analyze_cpu, is_trace, type CodeKind, type CpuFn, type CpuSummary } from './cpu.ts';
export { compare as fp_compare, type FpDrift, type KeptIsland } from './fp-drift.ts';
export { hole_segments, HOLE_SEG_LABEL } from './hole-segments.ts';
export {
	hydration_hazards,
	hazard_fix,
	hazard_words,
	type IslandHazard
} from './hydration-hazards.ts';
export { apply_attr_rules, type AttrRule } from './attr-rules.ts';

export {
	DEVTOOLS_COOKIE,
	DEVTOOLS_ON,
	DEVTOOLS_PARAM,
	TESTING_COOKIE,
	TESTING_LEAN,
	TESTING_PARAM,
	devtools_switched_on,
	switch_in_url,
	testing_lean,
	without_switch,
	write_switch
} from './switch.ts';
export { TESTING_ENGINE_VERSION } from './testing-version.ts';
