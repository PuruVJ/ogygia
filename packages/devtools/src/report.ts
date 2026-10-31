/**
 * `@ogygia/devtools/report` — reading a profiler report outside the profiler: opening an exported
 * `.ogp`, its JSON report, and the plain fix sum of an older report (`ogygia mcp` loads this from the
 * app's install).
 */
export { is_ogp, ogp_decode } from './profiler/crypto.ts';
export { report_json, is_dump } from './profiler/report.ts';
export { fix_impact } from './profiler/patterns.ts';
export type { Forecast } from './profiler/forecast.ts';
