# ogygia perf checkpoints

transformHost µs/call (lower better) · runtime chunk gzip B · docs cold build s. Recorded by `node verify/bench.ts <label>`.

| label | heavy µs | children µs | plain µs | docs rt gz | pg rt gz | docs build s |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 83.2 | 33.2 | 0.5 | 6682 | 7835 | 3.73 |
| opt1-cache+regex | 82.7 | 32.9 | 0.0 | 6682 | 7835 | 3.70 |
| opt2-single-parse | 83.3 | 32.9 | 0.0 | 6683 | 7834 | 3.67 |

## What changed per checkpoint
- **baseline** — before any optimization.
- **opt1-cache+regex** — (1) HEADLINE: removed `clear_transform_cache_for` from `unregister_host` — `register()` was evicting the content-keyed `transform_cache` immediately after `run_transform` wrote it (cache never hit → every host re-parsed 3× across prescan/SSR/client legs, plus an O(n) full-map scan per call = O(n²) over the build). Content-keying (`hit.code === source`) makes clearing unnecessary. (2) Memoized `import_keys_hint` RegExp + `normalize_import_keys` (were rebuilt per module per leg) → the no-island path (most files) went 0.5→0.0µs (~15×). (3) Hoisted invariant `KNOWN_STRATEGIES`/`HYDRATE_STRATEGIES`/`ATTR_SCHEMA`/`CHILD_KEYS`/`REGION_KEYS` out of per-call/per-import loops.
- **opt2-single-parse** — `appendTransportRegistrations` parses each `.ts/.js` once (was 2 oxc parses when a module had both a `class` and `createContext`).

Note: cold docs build stayed ~3.7s across all checkpoints — it is dominated by Svelte compilation + the 555 KB content bundle, NOT the ogygia transform (which the micro-bench shows is already <100µs/host). The cache-eviction fix removes real O(n²) work but is masked in total-build wall-clock by the compile/bundle cost. Remaining audit items (per-marked-import template re-walks, resolveId/load fast-path, prescan readFile cache) are low-ROI against that dominant cost.

## scale

| label | hosts | islands | content entries | transform ms | hosts/s | build+ids ms | get µs | backlink µs | entries ms | heap MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | 800 | 7902 | 200000 | 235 | 3404 | 85 | 0.34 | 1.46 | 15 | 164 |
| millions | 5000 | 49473 | 2000000 | 1263 | 3958 | 1169 | 0.47 | 12.46 | 216 | 874 |

### what the scale bench found (`node verify/bench-scale.ts [--huge]`)

Two O(N)-per-call bugs in the content collection, invisible on the docs site (small
catalog), fatal on a big one. A page doing K reads over an N-entry collection was O(K·N):

- **`get()` / `entry()` snapshotted the whole catalog** just to do one O(1) lookup —
  `ready()` returns `[...catalog.values()]`. Split out a non-snapshotting `#loaded()` for
  single-id reads. 200k-entry `get()`: **199.74µs → 0.34µs** (~590×).
- **backlink resolution rescanned every source collection on every `get()`** on a relation
  target (and each rescan itself snapshotted). Replaced with a version-cached inverted index
  (`#backlinks()`), and made relation/backlink loads use `#loaded()` not `ready()`. 50k-post
  target `get()`: **53µs → 1.46µs**; stays ~flat as the target grows.

Transform side was already linear and needed no change: 3400–4000 hosts/s, dedupe holds
(49k island usages → 420 distinct chunks at millions scale).
| render-vocab-refactor | 88.1 | 32.8 | 0.0 | 11997 | 13051 | - |
