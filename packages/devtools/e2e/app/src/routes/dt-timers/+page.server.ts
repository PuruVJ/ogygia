// THE SERVER TIMERS LAB for the profiler's answer key. PLANTED: every render starts an interval it
// never stops (`poll_prices`), and schedules a 30 s timer it never clears (`expire_later`). DECOYS: one
// interval for the whole process (started on the first request only) and a per-request timer cleared
// before the load returns. The report must name both plants and neither decoy.
let shared: ReturnType<typeof setInterval> | null = null;
const counts = { polls: 0, sweeps: 0 };

function poll_prices() {
	const id = setInterval(() => counts.polls++, 1000);
	// (the lab bounds its own pile: an unref'd cleanup, which the profiler leaves out by design)
	setTimeout(() => clearInterval(id), 60_000).unref();
}

function expire_later(key: string) {
	setTimeout(() => counts.sweeps++ && key, 30_000);
}

function sweep_once() {
	shared ??= setInterval(() => counts.sweeps++, 5000);
}

export const load = async () => {
	poll_prices();
	expire_later('price');
	sweep_once();
	const guard = setTimeout(() => counts.sweeps++, 5000);
	await new Promise((ok) => setTimeout(ok, 5));
	clearTimeout(guard);
	return { polls: counts.polls };
};
