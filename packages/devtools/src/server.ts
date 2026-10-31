/**
 * The SERVER half of `devtools()` (its `server`). With the profiler on it
 * wraps every request (`handle`): it times the render and serves its UI at `/__profiler`, and turns
 * on core's request stats, its data. The profiler itself — node:inspector, crypto, the UI's render
 * path — loads on the first request through a dynamic import, so an app pays for it only when it is
 * on; with `onDemand`, only once someone opens the profiler.
 */
import type { Handle } from '@sveltejs/kit';
import { defineServer, type ServerPlugin } from '@ogygia/core/plugin';
import { want_request_stats } from '@ogygia/core/internal/server';
import type { ProfilerOptions } from './profiler/index.ts';
import { profiler_demand_skip } from './profiler/on-demand.ts';

/** What `devtools()` hands its server half (vite.config → `virtual:ogygia/server-plugins`). The
 *  profiler's `secret` is here only when the app passed one (then it IS baked into the server build,
 *  on purpose — a serverless host may have no runtime env); left out, the profiler reads
 *  OGYGIA_PROFILER_SECRET at runtime. */
export interface DevtoolsServerOptions {
	profiler: ProfilerOptions | null;
}

/** the mounted profiler; `undefined` until the first request resolves it, `null` when unavailable */
let mounted: Handle | null | undefined;

async function mount(options: ProfilerOptions): Promise<Handle | null> {
	if (mounted !== undefined) return mounted;
	try {
		const { profiler } = await import('./profiler/index.ts');
		// a runtime store (`setProfilerStore` in hooks.server.ts): a live DB object the build-time options
		// could not carry, merged over them
		const { getProfilerStore } = await import('./profiler/storage/index.ts').catch(() => ({
			getProfilerStore: () => undefined
		}));
		const store = getProfilerStore();
		mounted = profiler({ ...options, ...(store ? { store } : {}) });
	} catch {
		mounted = null; // unavailable here (an edge runtime without node:inspector, …)
	}
	return mounted;
}

const server: ServerPlugin<DevtoolsServerOptions> = defineServer<DevtoolsServerOptions>({
	setup(app) {
		if (app.options.profiler) want_request_stats();
	},
	async handle({ event, options }, next) {
		const config = options.profiler;
		if (!config) return next();
		// DEMAND-ONLY: until a request asks for the profiler's path (and only until the first one mounts
		// it), this app pays exactly what a profiler-less app pays
		if (
			profiler_demand_skip(
				!!config.onDemand,
				mounted !== undefined,
				event.url.pathname,
				config.path || '/__profiler'
			)
		)
			return next();
		const prof = await mount(config);
		if (!prof) return next();
		// the profiler's `resolve` options (its beacon tag's transformPageChunk) see the finished document
		return prof({ event, resolve: (_event, opts) => next(opts) });
	}
});

export default server;
