// Shared Playwright fixtures + the suites' `check()` idiom — `@ogygia/tooling/e2e`, imported by every
// package's e2e specs (packages/<name>/e2e, apps/palaestra/e2e). Siblings (by file name, `.ts` and
// all): `/servers.ts` (spawn_server), `/re.ts` (shared regexes), `/packed.ts` (the packed ogygia),
// `/config.ts` (each suite's playwright.config.ts), `/build.ts` (a fixture app's build).
//
// The hand-rolled scripts collected a PASS/FAIL list and failed at the end. `check()` keeps that
// shape as SOFT assertions: every check in a test still runs, each failure is reported with its
// name and extra, and the test fails once at the end — so a migrated spec reads the same as the
// script it replaced, with Playwright's report, traces, and fixtures around it.
import { test as base, expect, type Page } from '@playwright/test';
import { ISLAND_GRAPH_SCRIPT_G_RE } from './re.ts';

export { expect };
export { REPO } from './paths.ts';
export const test = base;

/** A named soft assertion. `extra` (a measured value, a snippet) rides in the failure message. */
export function check(name: string, cond: unknown, extra = ''): void {
	expect.soft(!!cond, extra ? `${name} — ${extra}` : name).toBe(true);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The interaction lab's counter (`[data-i-count]`) reached 1 — the click that woke its island,
 *  replayed. The runtime replays a frame AFTER `data-hydrated` (the island's wiring settles first),
 *  so this waits for it instead of reading the counter the instant the island is marked. */
export async function replayed_once(page: Page): Promise<boolean> {
	return page
		.waitForFunction(() => document.querySelector('[data-i-count]')?.textContent === '1', null, {
			timeout: 2000
		})
		.then(
			() => true,
			() => false
		);
}

/** Every island graph script in a page's HTML, merged: entry → the chunks its code needs
 *  (src/island-graph.ts wire shape `{h:[href…], e:{entry:[index…]}}`). */
export function island_graph(html: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const m of html.matchAll(ISLAND_GRAPH_SCRIPT_G_RE)) {
		const wire = JSON.parse(m[1]) as { h: string[]; e: Record<string, number[]> };
		for (const [entry, ids] of Object.entries(wire.e))
			if (!out.has(entry))
				out.set(
					entry,
					ids.map((i) => wire.h[i])
				);
	}
	return out;
}

type StampWindow = Window & { __og_e2e_stamp?: number };

/**
 * SPA-vs-reload proof. A per-DOCUMENT stamp the TEST sets on the live window: an SPA body swap
 * keeps the window (and the stamp), a real document load replaces it (stamp gone). Read it back
 * with {@link document_stamp} after the navigation under test.
 */
export async function stamp_document(page: Page): Promise<number> {
	return page.evaluate(() => ((window as StampWindow).__og_e2e_stamp ??= Math.random()));
}

/** The stamp {@link stamp_document} set on this document, or `undefined` after a real load. */
export async function document_stamp(page: Page): Promise<number | undefined> {
	return page.evaluate(() => (window as StampWindow).__og_e2e_stamp);
}
