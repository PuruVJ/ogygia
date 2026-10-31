/**
 * The report shape the page's testing engine answers (`window.__ogygia_testing.version`). The engine
 * ships with the SITE's build and `ogygia/testing` with the TEST's package, so the two can differ: the
 * test side reads this from the page, fills in what it can for an older engine, and warns once.
 *
 * Each version, and what it DETECTS differently (results across two versions compare only where
 * nothing below changed):
 *
 * 1 — 0.8.2.
 * 2 — hydration `key`, session `navigations` (with what started each), finding `names`, `counts.cls`,
 *     `engine` on every report, hydration `t0` / `done`. Detection: a router navigation that never
 *     swapped the page no longer starts a new page for `page()`. Hydration status: unchanged from 1 (an
 *     island that reads `clean` on one and `changed` on the other differed in that run — input landing
 *     while it hydrated is the usual cause; 3 flags it as `input`).
 * 3 — hydration `change` (`attributes` / `markup`), `attributes`, `input`, `ignoreAttributes`; page
 *     `ogygia` (what measuring cost). Detection: unchanged — `changed` means what it meant in 2; the new
 *     fields only say what kind of change it was.
 */
export const TESTING_ENGINE_VERSION = 3;
