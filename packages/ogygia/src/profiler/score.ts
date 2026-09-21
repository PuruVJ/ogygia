/**
 * THE OGYGIA PAGE SCORE — one 0–100 number for a page, the way Lighthouse gives one, but scored on
 * what OGYGIA is for, not on generic web vitals alone. The framework's whole thesis is: ship the
 * least JS, hydrate correctly (no flash, no double render), keep the seed and the server render
 * small, and don't shift layout. So the score is a weighted blend of exactly those, each a 0–100
 * sub-score the report can show on its own — a developer reads WHERE the points went, not just the
 * total.
 *
 * Pure and inputs-only (no report/DOM types) so it unit-tests trivially and the weights/curves are
 * one place to tune. A category with no data (no visits → no vitals, or a build with no server
 * timing) is dropped and the remaining weights renormalize, so the score never punishes a missing
 * measurement.
 */

const KB = 1024;

/** A category's contribution: its own 0–100 score, the weight it carries, and one line of why. */
export interface ScoreCategory {
	key: 'js' | 'hydration' | 'seed' | 'server' | 'layout';
	label: string;
	/** 0–100 */
	score: number;
	/** relative weight BEFORE renormalization (categories with data renormalize to sum 1) */
	weight: number;
	/** the measured value behind the score, already formatted */
	value: string;
	/** one line: what this measures and, when it lost points, why */
	note: string;
}

export interface PageScore {
	/** 0–100, weighted over the categories that had data */
	score: number;
	/** A ≥90, B ≥75, C ≥60, D ≥40, else F — ogygia's own bands, not Lighthouse's */
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
	categories: ScoreCategory[];
	/** the single biggest point loss (weight × (100 − score)) — what to fix first, or null at a top score */
	worst: ScoreCategory | null;
}

export interface ScoreInputs {
	/** total island JS the page downloads to wake, bytes. `0` only when the page genuinely has no
	 *  islands; `null` when the page HAS islands but their chunk sizes were not measured (a dev
	 *  profile, or a build with no weight data) — then the JS category drops out rather than reading a
	 *  false perfect 100. */
	islandJsBytes: number | null;
	/** hydrations that discarded the server DOM and re-rendered (a mismatch) — a correctness fault */
	recovered: number;
	/** load/idle/visible islands that never reported hydrating while others did (mis-scheduled/broken) */
	neverWoke: number;
	/** page.data seed bytes shipped to the browser */
	seedBytes: number;
	/** SSR render time, ms (p50). `null` when not measured (no server timing in this report) */
	serverMs: number | null;
	/** the browser's vitals over the visits, or `null` when no visit reported them */
	vitals: { lcp: number | null; cls: number | null; inp: number | null } | null;
}

/** Linear score: 100 at `best`, 0 at `worst`, clamped, works whichever end is larger. */
function ramp(value: number, best: number, worst: number): number {
	if (best === worst) return 100;
	const t = (value - best) / (worst - best);
	return Math.max(0, Math.min(100, Math.round((1 - t) * 100)));
}

function grade_of(score: number): PageScore['grade'] {
	if (score >= 90) return 'A';
	if (score >= 75) return 'B';
	if (score >= 60) return 'C';
	if (score >= 40) return 'D';
	return 'F';
}

function fmt_kb(bytes: number): string {
	return bytes >= KB ? `${Math.round(bytes / KB)} KB` : `${bytes} B`;
}

/**
 * Score a page from its ogygia signals. Weights (before renormalization):
 *   JS shipped 30 · hydration integrity 25 · seed 15 · server render 15 · layout 15.
 * JS and hydration dominate because they are what ogygia most directly controls; layout/server ride
 * on beacon + server data that may be absent, and drop out cleanly when they are.
 */
export function page_score(inp: ScoreInputs): PageScore {
	const cats: ScoreCategory[] = [];

	// JS shipped — the core promise. A load-only island app is ~8 KB of runtime; a page that ships
	// almost none scores top, and it falls off past a couple hundred KB of island code. Dropped when
	// the island chunk sizes were not measured (`null`) — an unmeasured category never scores 100.
	if (inp.islandJsBytes !== null) {
		const js = ramp(inp.islandJsBytes, 20 * KB, 400 * KB);
		cats.push({
			key: 'js',
			label: 'JS shipped',
			score: js,
			weight: 30,
			value: fmt_kb(inp.islandJsBytes),
			note:
				js === 100
					? 'The page ships almost no island JS — the whole point.'
					: `${fmt_kb(inp.islandJsBytes)} of island JS loads to wake the page. Move the heaviest import server-side, make a static subtree a lake, or wake on interaction.`
		});
	}

	// Hydration integrity — a correctness score, not a speed one. A recovered island flashed and
	// rendered twice; an island that never woke is dead interactivity. Either is a real fault, so the
	// penalty is steep: one recovery already costs a third of the category.
	const hydration = Math.max(0, 100 - (inp.recovered * 34 + inp.neverWoke * 20));
	cats.push({
		key: 'hydration',
		label: 'Hydration integrity',
		score: hydration,
		weight: 25,
		value: `${inp.recovered} recovered, ${inp.neverWoke} never woke`,
		note:
			hydration === 100
				? 'Every island hydrated cleanly from its server markup.'
				: `${inp.recovered} island hydration(s) discarded the server DOM and re-rendered (a flash + double render), and ${inp.neverWoke} island(s) never woke. Something reshapes the markup between SSR and wake, or an island throws — the recovered-reason in the Islands table names it.`
	});

	// Seed — page.data shipped to the browser. Seed shaping keeps this to the keys islands read.
	const seed = ramp(inp.seedBytes, 10 * KB, 200 * KB);
	cats.push({
		key: 'seed',
		label: 'Page seed',
		score: seed,
		weight: 15,
		value: fmt_kb(inp.seedBytes),
		note:
			seed === 100
				? 'The seed is small — only the page.data an island reads ships.'
				: `${fmt_kb(inp.seedBytes)} of page.data ships and is serialized every render. Read fewer keys in islands, or reference page.data nodes from props.`
	});

	// Server render — the SSR CPU per request. Dropped when this report has no server timing.
	if (inp.serverMs !== null) {
		const server = ramp(inp.serverMs, 10, 200);
		cats.push({
			key: 'server',
			label: 'Server render',
			score: server,
			weight: 15,
			value: `${Math.round(inp.serverMs)} ms`,
			note:
				server === 100
					? 'The server renders the page cheaply.'
					: `${Math.round(inp.serverMs)} ms of SSR per request. The findings above name the components whose render dominates.`
		});
	}

	// Layout & paint — from the browser's vitals when a visit reported them: CLS (shift), LCP (paint),
	// INP (responsiveness), averaged. Dropped entirely when there are no visits yet.
	const v = inp.vitals;
	if (v && (v.cls !== null || v.lcp !== null || v.inp !== null)) {
		const parts: number[] = [];
		if (v.cls !== null) parts.push(ramp(v.cls, 0.1, 0.25));
		if (v.lcp !== null) parts.push(ramp(v.lcp, 2500, 4000));
		if (v.inp !== null) parts.push(ramp(v.inp, 200, 500));
		const layout = Math.round(parts.reduce((s, x) => s + x, 0) / parts.length);
		cats.push({
			key: 'layout',
			label: 'Layout & paint',
			score: layout,
			weight: 15,
			value: [
				v.cls !== null ? `CLS ${v.cls}` : null,
				v.lcp !== null ? `LCP ${Math.round(v.lcp)} ms` : null,
				v.inp !== null ? `INP ${Math.round(v.inp)} ms` : null
			]
				.filter(Boolean)
				.join(' · '),
			note:
				layout >= 90
					? 'Stable and fast to paint in the visits measured.'
					: 'Layout shifted or paint was slow in the visits measured — a hero without reserved height, or an island whose CSS arrives after paint.'
		});
	}

	// Renormalize over the categories that had data, so a missing measurement never costs points.
	const total_weight = cats.reduce((s, c) => s + c.weight, 0);
	const score = total_weight
		? Math.round(cats.reduce((s, c) => s + c.score * c.weight, 0) / total_weight)
		: 100;

	// Biggest point loss to fix first: weight-share × the gap to 100.
	let worst: ScoreCategory | null = null;
	let worst_loss = 0;
	for (const c of cats) {
		const loss = (c.weight / (total_weight || 1)) * (100 - c.score);
		if (loss > worst_loss) {
			worst_loss = loss;
			worst = c;
		}
	}

	return { score, grade: grade_of(score), categories: cats, worst: worst_loss > 0 ? worst : null };
}
