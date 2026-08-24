# `ogygia/profiler`

A drop-in, production-safe SSR profiler for SvelteKit. It answers one question:
**why is this server render slow?** — and names the slow components, functions,
network calls, and allocations, with zero per-component instrumentation.

It watches the whole Node process during a render, so it sees everything:
component SSR, `load` functions, markdown/serialization, utilities, garbage
collection, and time spent _waiting_ on the network. Svelte compiles every
component to a function named after its file, so the profile attributes render
time to your components by itself.

## Install

One line in `src/hooks.server.ts`:

```ts
import { sequence } from '@sveltejs/kit/hooks';
import { profiler } from 'ogygia/profiler';

export const handle = sequence(profiler() /* ...your other handles */);
```

Put it **first** in the sequence so it times the whole chain below it. In
production, set a secret so the UI is reachable:

```bash
OGYGIA_PROFILER_SECRET=some-long-random-string
```

Then open **`/__profiler`** (add `?key=<secret>` in production).

## Three ways to record

- **Record the live server** — records for N seconds while real traffic flows,
  then shows what every request did. Best for "the site is slow under load".
- **Profile one page** — renders a path N times back-to-back and profiles just
  that. Best for "this page is slow". Does one warm-up render first so the
  median isn't skewed by cold module loading.
- **Profile one request** — send any request with the header
  `x-profile: <secret>` and get a profile of exactly that request. The report
  URL comes back in the `x-profile-report` response header. (This adds the
  profiler's start-up cost to that one request's latency.)

## What the report shows

- **Where the time went** — one bar for the whole window. If the biggest
  segment is "idle / waiting", the server was blocked on I/O, not computing.
- **CPU by self time** — an interactive treemap; the biggest box is the
  bottleneck. Click a box to zoom in.
- **Components** — sortable by self or total. _self_ = the component's own code;
  _total_ = self plus everything it calls. Sort by self to find the real CPU
  burners (ancestors like `_layout`/`Root` sink to the bottom).
- **Network** — every outbound `fetch`/`http` call, tied to the route that made
  it, with a waterfall. Flags calls that ran back-to-back (sequential `await`s).
- **Memory** — top allocators, RSS over time, and precise GC pauses.
- A **flame graph**, and a raw **`.cpuprofile`** download for Chrome DevTools or
  speedscope.app.

## For agents and scripts

Every report is also curated JSON (not the raw V8 profile — the analyzed result):

```
GET <path>/report/<id>.json
GET <path>/page?p=/slow/page&runs=6&format=json&key=<secret>   # profile + JSON in one shot
```

`Accept: application/json` on `/record` or `/page` does the same. The payload is
self-describing (`schema`, `version`, units) and carries the summary + `verdict`,
structured `findings` (each with a stable `code`), the `budget`, per-component
`self`/`total`, `hot_functions`, `network`, and `memory`.

## Cost and safety

- **When idle it does almost nothing.** It only samples the CPU while you are
  recording (~1–3% during a recording, zero otherwise).
- **Always-on parts** (per request): wall timing, a rolling request log (capped,
  in memory), and — unless you turn network off — one `AsyncLocalStorage` wrap
  plus a `fetch`/`http` patch. Pass `{ network: false }` for the leanest path
  (wall timing only, no context, no global patches).
- **`Server-Timing` headers** expose internal timings to every client, so they
  are **on in dev, off in production** by default. Pass `{ serverTiming: true }`
  to force them on.
- **The UI is gated.** In production it 404s without the secret; matching is
  timing-safe. Recorded profiles live only in memory (the last few, gzipped) and
  are never written to disk.

## Platform support

Needs a **Node.js server** (`adapter-node`, `vite preview`, most Node hosts) —
it uses the built-in V8 inspector. On edge/serverless runtimes without the
inspector (Cloudflare Workers, Deno Deploy), the UI shows a clear message and
the always-on request log still works; CPU/heap recording does not.

## Options

```ts
profiler({
	secret: process.env.OGYGIA_PROFILER_SECRET, // default: OGYGIA_PROFILER_SECRET env
	path: '/__profiler', // UI base path
	sampleInterval: 500, // µs between CPU samples
	maxReports: 6, // profiles kept in memory (gzipped)
	network: true, // patch fetch/http for attribution
	serverTiming: undefined, // default: on in dev, off in prod
	heap: true, // sample heap allocations while recording
	enabled: true // master switch
});
```

## Sharper names in production (optional)

Build with server source maps so bundled frames map back to source files and
anonymous functions recover their names:

```ts
// vite.config.ts
export default defineConfig({
	build: process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : undefined
	// ...
});
```

Then `PROFILER_SOURCEMAPS=1 vite build`. The report header shows "sourcemapped"
when it worked.
