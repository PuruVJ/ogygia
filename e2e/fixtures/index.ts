// Shared Playwright fixtures + the suites' `check()` idiom.
//
// The hand-rolled scripts collected a PASS/FAIL list and failed at the end. `check()` keeps that
// shape as SOFT assertions: every check in a test still runs, each failure is reported with its
// name and extra, and the test fails once at the end — so a migrated spec reads the same as the
// script it replaced, with Playwright's report, traces, and fixtures around it.
import { test as base, expect } from '@playwright/test';

export { expect };
export const test = base;

/** A named soft assertion. `extra` (a measured value, a snippet) rides in the failure message. */
export function check(name: string, cond: unknown, extra = ''): void {
	expect.soft(!!cond, extra ? `${name} — ${extra}` : name).toBe(true);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
