// FIX ONCE, FASTER EVERYWHERE: a slow line in a shared helper (the price formatter, the i18n lookup)
// shows in the report of every page that calls it. Each report names it for its own page; this adds
// them up across the pages this server profiled, from the latest report of each — one line, what
// fixing it gives back per render on each page, and in all. What only one page has is that page's
// report's business; this lists the lines two or more pages share.

import type { Pattern, PatternKind } from './patterns.js';

export interface SiteFix {
	kind: PatternKind;
	/** the pattern's title, without its "(N places)" */
	title: string;
	/** the line: its source module when the build had no sourcemap, else its file */
	where: string;
	line: number;
	code: string;
	/** per render on each page it slows, ms (biggest first) */
	pages: { page: string; ms: number; report: string }[];
	/** the sum over those pages, ms per render (one render of each) */
	total_ms: number;
}

/** keeping an answer, or the whole page, is a freshness decision per page, not one shared fix */
const NOT_SHARED: ReadonlySet<PatternKind> = new Set<PatternKind>([
	'same-answer',
	'almost-same-answer',
	'same-document',
	'almost-same-document'
]);

const bare = (t: string) => {
	const i = t.lastIndexOf(' (');
	return i !== -1 && (t.endsWith(' places)') || t.endsWith(' place)')) ? t.slice(0, i) : t;
};

export function site_fixes(
	reports: readonly {
		id: string;
		page: string;
		created: number;
		runs: number;
		patterns?: readonly Pattern[];
	}[],
	limit = 8
): SiteFix[] {
	// the latest report of each page: an older one describes code that may be fixed by now
	const latest = new Map<string, (typeof reports)[number]>();
	for (const r of reports) {
		const had = latest.get(r.page);
		if (!had || r.created > had.created) latest.set(r.page, r);
	}
	const by = new Map<string, SiteFix>();
	for (const r of latest.values()) {
		const n = Math.max(1, r.runs);
		for (const p of r.patterns ?? []) {
			if (NOT_SHARED.has(p.kind) || p.kept_bytes || p.seed_bytes || !(p.save_ms > 0)) continue;
			const per_render = p.wait ? p.save_ms : p.save_ms / n;
			// each site's share of the pattern's saving: by its own cost
			const cost = (s: Pattern['sites'][number]) => s.wait_ms ?? s.cpu_ms ?? 0;
			const total = p.sites.reduce((t, s) => t + cost(s), 0);
			for (const s of p.sites) {
				const share = total > 0 ? cost(s) / total : 1 / p.sites.length;
				const ms = per_render * share;
				if (ms <= 0) continue;
				const where = s.module ?? s.file;
				// (the code too: two pages' latest reports can come from different builds, and a built
				// chunk's line number can hold another statement in each)
				const key = `${p.kind}\0${where}\0${s.line}\0${(s.code ?? '').trim()}`;
				const f =
					by.get(key) ??
					by
						.set(key, {
							kind: p.kind,
							title: bare(p.title),
							where,
							line: s.line,
							code: s.code,
							pages: [],
							total_ms: 0
						})
						.get(key)!;
				const on = f.pages.find((x) => x.page === r.page);
				if (on) on.ms += ms;
				else f.pages.push({ page: r.page, ms, report: r.id });
				f.total_ms += ms;
			}
		}
	}
	const r2 = (x: number) => Math.round(x * 100) / 100;
	return [...by.values()]
		.filter((f) => f.pages.length >= 2)
		.map((f) => ({
			...f,
			total_ms: r2(f.total_ms),
			pages: f.pages.map((x) => ({ ...x, ms: r2(x.ms) })).sort((a, b) => b.ms - a.ms)
		}))
		.sort((a, b) => b.total_ms - a.total_ms)
		.slice(0, limit);
}
