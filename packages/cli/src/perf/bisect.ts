/**
 * BISECT — "this page got slower somewhere in the last N commits": a binary search over the
 * commits between a known-good and a known-bad one, measuring each, that names the first commit
 * past the threshold. The search is pure and takes its `measure` from outside (a test hands it a
 * table; the CLI hands it build + start + profile). Noise is handled the way a human would: the
 * good and bad ends are measured first to set the bar, and a commit counts as bad only when it is
 * over the bar by the margin.
 */
export interface BisectStep {
	sha: string;
	/** the metric measured at that commit (null: could not build / measure — skipped) */
	value: number | null;
	bad: boolean;
	ms: number;
}

export interface BisectResult {
	/** the first bad commit, or null when every commit measured good (the regression is not in the range) */
	culprit: string | null;
	/** the last good commit before it */
	last_good: string | null;
	good_value: number;
	bad_value: number;
	/** the bar a commit had to cross to count as bad */
	bar: number;
	steps: BisectStep[];
	/** commits that could not be measured and were skipped */
	skipped: string[];
}

export interface BisectOptions {
	/** the commits from good (exclusive) to bad (inclusive), oldest first — `git rev-list --reverse good..bad` */
	commits: string[];
	/** the metric at the known-good commit and at the known-bad one */
	good_value: number;
	bad_value: number;
	/** a commit is bad when its value is over good + this share of the (bad − good) gap (default 0.5) */
	margin?: number;
	/** measure one commit; null when it cannot be built or measured */
	measure: (sha: string) => Promise<number | null>;
	on_step?: (s: BisectStep) => void;
}

export async function bisect(opts: BisectOptions): Promise<BisectResult> {
	const { commits, good_value, bad_value } = opts;
	const margin = opts.margin ?? 0.5;
	const bar = good_value + (bad_value - good_value) * margin;
	const steps: BisectStep[] = [];
	const skipped: string[] = [];
	if (bad_value <= good_value) {
		return { culprit: null, last_good: null, good_value, bad_value, bar, steps, skipped };
	}
	// invariant: commits[lo] and everything before it is good (or unknown at lo = -1); commits[hi] is bad
	let lo = -1;
	let hi = commits.length - 1;
	const known = new Map<string, boolean>();
	if (hi >= 0) known.set(commits[hi], true);
	while (hi - lo > 1) {
		// the midpoint, then the nearest unskipped commit around it
		const mid = lo + Math.floor((hi - lo) / 2);
		let pick = -1;
		for (let d = 0; mid - d > lo || mid + d < hi; d++) {
			if (mid + d < hi && !skipped.includes(commits[mid + d])) {
				pick = mid + d;
				break;
			}
			if (mid - d > lo && !skipped.includes(commits[mid - d])) {
				pick = mid - d;
				break;
			}
		}
		if (pick === -1) break; // everything between is unmeasurable
		const sha = commits[pick];
		const t = Date.now();
		let value: number | null = null;
		try {
			value = await opts.measure(sha);
		} catch {
			value = null;
		}
		const step: BisectStep = { sha, value, bad: value !== null && value > bar, ms: Date.now() - t };
		steps.push(step);
		opts.on_step?.(step);
		if (value === null) {
			skipped.push(sha);
			continue;
		}
		known.set(sha, step.bad);
		if (step.bad) hi = pick;
		else lo = pick;
	}
	const culprit = hi >= 0 && hi < commits.length ? commits[hi] : null;
	const last_good = lo >= 0 ? commits[lo] : null;
	return { culprit, last_good, good_value, bad_value, bar, steps, skipped };
}
