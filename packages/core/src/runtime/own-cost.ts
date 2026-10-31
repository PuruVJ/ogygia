/**
 * What MEASURING costs the page's main thread, by phase (ms): the work devtools and the profiler's
 * beacon do only because someone measures — checking each island's markup as it hydrates, building the
 * visit, the testing API's reports. A visitor with devtools off pays none of it, so a test subtracts it
 * (`page().ogygia`) and a CPU comparison across ogygia versions stays about the page.
 */
// (one ledger for the page: the runtime and the devtools chunks can each carry a copy of this module)
const spent: Record<string, number> = ((globalThis as Record<symbol, Record<string, number>>)[
	Symbol.for('ogygia.own-cost')
] ??= {});

/** Add the time since `t0` to `phase`. */
export function charge(phase: string, t0: number): void {
	spent[phase] = (spent[phase] ?? 0) + (performance.now() - t0);
}

/** Run `fn`, charging its time to `phase`. */
export function metered<T>(phase: string, fn: () => T): T {
	const t0 = performance.now();
	try {
		return fn();
	} finally {
		charge(phase, t0);
	}
}

/** The cost so far, rounded: `{ ms, phases }`. */
export function own_cost(): { ms: number; phases: Record<string, number> } {
	const phases: Record<string, number> = {};
	let ms = 0;
	for (const k in spent) {
		phases[k] = Math.round(spent[k] * 10) / 10;
		ms += spent[k];
	}
	return { ms: Math.round(ms * 10) / 10, phases };
}
