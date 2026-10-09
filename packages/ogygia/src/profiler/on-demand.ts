/**
 * DEMAND-ONLY profiler routing (`profiler: { onDemand: true }`).
 *
 * The whole decision the handle makes each request BEFORE it would import the profiler: skip the
 * profiler entirely — no import, no parse, no init, no per-request wrap — when the mode is on, it has
 * not been mounted yet this process, and this request is not for the profiler UI. Reads only plain
 * values, so no profiler code is loaded to decide. `/__profiler` is a reserved, clash-safe path, so a
 * substring test is safe: it can only ever mount the profiler EARLY (harmless — the same cost normal
 * mode always pays), never MISS a real profiler request (which would break the dashboard).
 */
export function profiler_demand_skip(
	on_demand: boolean,
	profiler_mounted: boolean,
	pathname: string,
	ui_path: string
): boolean {
	return on_demand && !profiler_mounted && !pathname.includes(ui_path);
}
