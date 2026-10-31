import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { devtools } from '@ogygia/devtools/vite';
import { defineConfig } from 'vite';

// THE DEVTOOLS LAB: @ogygia/devtools' e2e fixture app. Its pages plant known problems (the dt-* labs,
// the profiler's hell / inferno / purgatory / limbo / latecomer answer-key pages, the score lab) for
// the dock, the profiler and @ogygia/testing to find; the answer keys in internal/bench drive it too.
export default defineConfig({
	// (the profiler's server build writes hidden maps by itself; PROFILER_NO_SOURCEMAPS=1 builds without
	// any, the way an app that turned them off does — what the answer key's `--no-maps` measures)
	build: {
		...(process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : {}),
		...(process.env.PROFILER_NO_SOURCEMAPS ? { sourcemap: false } : {})
	},
	// (adapter-vercel writes `.vercel/output`, a copy of the server's whole dependency tree; the dev
	// servers the specs start in this folder must not watch it)
	server: { watch: { ignored: ['**/.vercel/**'] } },
	plugins: [
		ogygia({
			// the palaestra's core options, so the lab's copies of its pages render the same way
			barrels: true,
			router: { serverDelta: true },
			visible: { margin: '0px' },
			presets: {
				// the hell page's second recommendations hole: a render cache the profiler's hole
				// economics can watch (hits vs misses)
				cachedRecs: { render: 'deferred', maxAge: '5m' }
			}
		}),
		// devtools: the SSR profiler, always (its UI islands build, its handle mounts it; secret from
		// OGYGIA_PROFILER_SECRET at runtime; + the background recorders the hell page exercises: a trap
		// for any request over 400 ms, a 1 s coarse sample every 20 s; serverTiming on in the built
		// preview too, so the hell page's own API routes answer the profiler's nested-trace ask). The
		// DOCK is on with OGYGIA_DEVTOOLS=1 (the dev-server specs set it).
		devtools({
			dock: !!process.env.OGYGIA_DEVTOOLS,
			profiler: {
				trap: { over: 400, keep: 3 },
				sample: { every: 20, window: 1000 },
				serverTiming: true
			}
		}),
		sveltekit()
	]
});
