// Shared Playwright fixtures + the suites' `check()` idiom.
//
// The hand-rolled scripts collected a PASS/FAIL list and failed at the end. `check()` keeps that
// shape as SOFT assertions: every check in a test still runs, each failure is reported with its
// name and extra, and the test fails once at the end — so a migrated spec reads the same as the
// script it replaced, with Playwright's report, traces, and fixtures around it.
import { test as base, expect, type Page } from '@playwright/test';

export { expect };
export const test = base;

/** A named soft assertion. `extra` (a measured value, a snippet) rides in the failure message. */
export function check(name: string, cond: unknown, extra = ''): void {
	expect.soft(!!cond, extra ? `${name} — ${extra}` : name).toBe(true);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
