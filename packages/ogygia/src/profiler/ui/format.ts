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

/** A duration in ms, with the unit that keeps it readable: `1.20 ms`, `46 µs`, `8 ns`. For per-call
 *  costs, where a hot getter can cost nanoseconds a call and fixed decimals print it as zero. */
export const fmt_dur = (ms: number): string => {
	if (!Number.isFinite(ms) || ms <= 0) return '—';
	if (ms >= 1) return `${fmt_ms(ms)} ms`;
	const us = ms * 1000;
	if (us >= 1) return `${us >= 100 ? us.toFixed(0) : us >= 10 ? us.toFixed(1) : us.toFixed(2)} µs`;
	const ns = us * 1000;
	return `${ns >= 10 ? ns.toFixed(0) : ns.toFixed(1)} ns`;
};

/** part/whole as a percentage, or an em-dash when whole is 0. */
export const fmt_pct = (part: number, whole: number): string =>
	whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—';

/** bytes → MB / kB / B. */
export const fmt_bytes = (n: number): string =>
	n >= 1048576
		? (n / 1048576).toFixed(1) + ' MB'
		: n >= 1024
			? (n / 1024).toFixed(0) + ' kB'
			: n + ' B';

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

/** The text color for a label on `bg` (`#rrggbb`): near-black or white, whichever contrasts more
 *  (a chip's background is a data color, light or dark: one fixed ink failed 4.5:1 on half of them). */
export function ink_on(bg: string): string {
	if (bg.length !== 7 || bg[0] !== '#') return 'var(--text-on-accent)';
	const ch = (i: number) => {
		const v = parseInt(bg.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const L = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
	// contrast against white (L 1) vs against #06120c (L ≈ 0.005)
	return (1.05 / (L + 0.05) >= (L + 0.05) / 0.055) ? '#ffffff' : '#06120c';
}

/** Bar color per I/O kind, for the Waiting-by-function bars. */
export function kind_color(kind: string): string {
	switch (kind) {
		case 'http':
			return '#5b8fd6';
		case 'timer':
			return '#b58a3d';
		case 'file':
			return '#4a9d6e';
		case 'socket':
			return '#c1544f';
		case 'dns':
			return '#7d6bb0';
		default:
			return '#8a8f98';
	}
}

/** A report's one-line label for lists + headers. */
export function label_of(r: ReportMeta): string {
	if (r.trigger === 'page') return `page ${r.page} ×${r.runs?.length ?? 0}`;
	if (r.trigger === 'request') return `request ${r.request?.path ?? ''}`;
	if (r.trigger === 'trap') return `caught ${r.request?.path ?? ''} (${Math.round(r.request?.ms ?? 0)} ms)`;
	return `${Math.round(r.duration_ms / 1000)}s window`;
}
