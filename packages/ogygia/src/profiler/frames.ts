/**
 * The profiler's OWN frames, so a caller lookup skips them whatever the bundler named the file.
 *
 * Bundlers rename our source (net.ts → chunks/net2.js, or straight into the app's chunk when the
 * package is a workspace link), so a path substring like '/profiler/' won't match at runtime.
 * Each profiler module calls `register_profiler_file()` at load; it reads the CALLER's file from
 * a structured stack trace — the same format the caller lookup later compares against — so those
 * frames are skipped by identity. Dependency-free and V8-guarded: `span.ts` (universal) registers
 * itself too, and on an engine without `captureStackTrace` it simply does nothing.
 */
const profiler_files = new Set<string>();

/** Grab the structured call-sites WITHOUT triggering Node's stack-string formatter
 *  (`defaultPrepareStackTrace`). Reading `new Error().stack` on every I/O call formatted the
 *  whole stack and showed up as node-core CPU in the profile — the profiler measuring itself. */
export function call_sites(below: (...a: never[]) => unknown): NodeJS.CallSite[] {
	const E = Error as unknown as {
		prepareStackTrace?: unknown;
		captureStackTrace?: (o: object, f: (...a: never[]) => unknown) => void;
	};
	if (typeof E.captureStackTrace !== 'function') return [];
	const orig = E.prepareStackTrace;
	E.prepareStackTrace = (_e: unknown, sites: unknown) => sites;
	const holder: { stack?: unknown } = {};
	E.captureStackTrace(holder, below);
	// `.stack` is lazy: read it WHILE our override is installed, then restore —
	// otherwise the default (or source-map-support) formatter runs and returns a string
	const sites = holder.stack;
	E.prepareStackTrace = orig;
	return Array.isArray(sites) ? (sites as NodeJS.CallSite[]) : [];
}

/** Call at module load from any profiler module: its runtime file name joins the skip set. */
export function register_profiler_file(): void {
	const f = call_sites(register_profiler_file)[0]?.getFileName();
	if (f) profiler_files.add(f);
}

export function is_profiler_file(file: string): boolean {
	return profiler_files.has(file) || file.includes('/profiler/');
}
