/**
 * Formatting + category maps shared across the profiler UI components. The old report.ts baked these
 * into HTML strings; the components import them and interpolate in `{}` (Svelte auto-escapes, so the
 * old `esc()` is gone). Pure functions / constants — no DOM, safe on the server render.
 */
import type { FrameCategory } from '../analyze.js';
import type { ReportMeta } from '../report.js';

/** ms with sensible precision: whole numbers over 100, one dp over 10, two dp below. */
export const fmt_ms = (n: number): string =>
	n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);

/** part/whole as a percentage, or an em-dash when whole is 0. */
export const fmt_pct = (part: number, whole: number): string =>
	whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—';

/** bytes → MB / kB / B. */
export const fmt_bytes = (n: number): string =>
	n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' kB' : n + ' B';

export const CATEGORY_LABEL: Record<FrameCategory, string> = {
	component: 'component',
	app: 'app code',
	dependency: 'dependency',
	svelte: 'svelte',
	node: 'node core',
	gc: 'GC',
	idle: 'idle',
	v8: 'v8',
	profiler: 'profiler',
	unknown: '—'
};

export const CATEGORY_COLOR: Record<FrameCategory, string> = {
	component: '#e8734a',
	app: '#4a9d6e',
	dependency: '#5b8fd6',
	svelte: '#c1544f',
	node: '#8a8f98',
	gc: '#b58a3d',
	idle: '#3a3f47',
	v8: '#6b7280',
	profiler: '#7d6bb0',
	unknown: '#6b7280'
};

/** A report's one-line label for lists + headers. */
export function label_of(r: ReportMeta): string {
	if (r.trigger === 'page') return `page ${r.page} ×${r.runs?.length ?? 0}`;
	if (r.trigger === 'request') return `request ${r.request?.path ?? ''}`;
	return `${Math.round(r.duration_ms / 1000)}s window`;
}
