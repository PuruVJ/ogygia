/**
 * The report shape the page's testing engine answers (`window.__ogygia_testing.version`). The engine
 * ships with the SITE's build and `ogygia/testing` with the TEST's package, so the two can differ: the
 * test side reads this from the page, fills in what it can for an older engine, and warns once.
 *
 * 1 — 0.8.2. 2 — hydration keys, session `navigations` (with what started each), finding names,
 * `counts.cls`, `engine` on every report.
 */
export const TESTING_ENGINE_VERSION = 2;
