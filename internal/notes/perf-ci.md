# Perf in CI — catch the regression in the PR

Status: DESIGN, not built (2026-09-20). Companion to `perf-audit.md` (the server cost program) and
the profiler (`src/profiler/`). Written so the pieces can be built one at a time, each useful alone.

## The want

A pull request that makes a page slower should say so on the PR, with the component or function
that moved, before anyone merges it. Today the profiler answers "why is this slow" for a human at a
URL; nothing answers it for a robot at a commit. The gap is not measurement (the profiler already
produces a machine-readable report with components, functions, phases, the critical path, ogygia's
own bytes) — it is the SHAPE around it: what to run, where, against what baseline, with what
verdict, and how it reaches the PR.

## One sentence

`ogygia perf` renders a list of pages under the CPU profiler on a built app, writes a small JSON
snapshot, diffs it against the baseline snapshot for the base branch, and prints a verdict a CI
step can fail on and a PR comment can show.

## Shape

```
                 ┌────────────────────────────┐
  pages.json ──▶ │ ogygia perf                │ ──▶ perf-snapshot.json   (artifact)
  (what)         │  build (or reuse)          │ ──▶ verdict (exit code)
                 │  boot the server           │ ──▶ PR comment (markdown)
  baseline ────▶ │  render each page ×N       │
  (from base)    │  profile + phase + ogygia  │
                 │  compare + gate            │
                 └────────────────────────────┘
```

Three layers, each a separate module with its own tests, so the runner is swappable (GitHub
Actions today, GitLab or a cron tomorrow) and the target is swappable (a local `vite preview`
today, an Amplify deploy tomorrow):

1. **Measure** — `packages/ogygia/src/perf/measure.ts`. Given a base URL and a page list, produce a
   `PerfSnapshot`. Two modes:
   - *in-process* (default): start the built adapter-node server in this process with the profiler
     enabled (`ogygia({ profiler: true })` in the app's vite config is NOT required — the runner
     mounts the profiler itself through the same `#ensure_profiler` seam, keyed by an env flag), then
     hit `/__profiler/page?p=<page>&runs=N&format=json` for each page. This is exactly the report
     the UI reads: `summary`, `components`, `hot_functions`, `timeline.phases`, `ogygia`. Zero new
     instrumentation.
   - *remote* (Amplify, any deploy): the same `/page?format=json` call against a deployed preview
     URL with `x-profiler-key`. Needs the profiler enabled on that deploy (it already runs in prod
     behind the secret, and page mode already fits the serverless budget — see `serverless_work_budget_ms`).
     Same JSON, same snapshot, same compare; the runner only differs in where the server is.
2. **Compare** — `packages/ogygia/src/perf/compare.ts`. Pure: `(baseline, current, budget) →
   Verdict`. Per page: median render Δ, CPU busy Δ, phases Δ, top component/function deltas (reuse
   `profiler/compare.ts` `compare_reports`, which already does the row diff), ogygia bytes Δ (seed,
   props). The budget says what counts: a relative threshold (default +8 % on median render, +15 %
   on any one component's self, +20 KB on the seed), an absolute floor so a 1 ms page can't fail on
   noise (default 5 ms), and per-page overrides.
3. **Report** — `packages/ogygia/src/perf/report.ts`. The verdict as (a) a markdown comment (one
   table per page: metric, base, PR, Δ, and the three biggest movers with file:line), (b) a
   GitHub check summary, (c) `perf-snapshot.json` for the next run's baseline, (d) exit code.

## What a snapshot holds

Small on purpose (a few KB per page): the numbers a diff needs, never the profile.

```jsonc
{
  "schema": "ogygia-perf-snapshot", "version": 1,
  "commit": "abc123", "ref": "refs/pull/42/merge", "created": 1758300000000,
  "node": "v22.4.0", "runner": "github-actions/ubuntu-24.04", "mode": "in-process",
  "pages": {
    "/": {
      "runs": 7, "render_ms": { "median": 41.2, "p90": 44.0, "min": 39.8 },
      "busy_ms": 31.5, "gc_ms": 1.2, "wait_ms": 6.1, "html_bytes": 187210,
      "phases": { "load": { "cpu": 2.1, "wait": 6.1 }, "render": { "cpu": 24.0, "wait": 0 }, "ogygia": { "cpu": 3.9, "wait": 0 }, "kit": { "cpu": 1.5, "wait": 0 } },
      "ogygia": { "transform_ms": 3.9, "islands": 21, "seed_bytes": 102400, "tail_bytes": 133120 },
      "components": [ { "name": "HeavyRow", "self": 12.3, "total": 14.1, "calls": 800, "file": "src/lib/HeavyRow.svelte", "line": 1 } ],
      "functions":  [ { "key": "fmt src/lib/fmt.ts", "name": "fmt", "self": 4.4, "file": "src/lib/fmt.ts", "line": 12 } ],
      "net": { "count": 3, "ms": 6.1, "sequential_ms": 4.0 }
    }
  }
}
```

`components` and `functions` keep the top 40 by self; the diff joins on `name` / `key` the way the
profiler's compare page does.

## Where the baseline lives

Options, in order of preference:

1. **The base branch's last snapshot as a workflow artifact** — the job on `main` uploads
   `perf-snapshot.json`; the PR job downloads the latest for `main`. No extra service, expires with
   the artifact retention (set 90 days). This is the default.
2. **A committed snapshot** (`.ogygia/perf-baseline.json`, refreshed by a bot commit on `main`).
   Survives retention and works offline; adds a commit per merge.
3. **Measure both in one job** — check out base, build, measure; check out head, build, measure.
   Twice the cost, but the two runs share the runner, which is the only way to get a stable Δ on
   noisy hosted runners. Offered as `--against base` for the pages that matter most.

Start with 1, keep 3 as the accurate mode for `perf-critical` labelled PRs.

## Noise, and how the verdict stays honest

Hosted runners are noisy (±10 % run to run is normal). The measurement takes that on directly:

- N renders per page (default 7), the **median** is the number; p90 and min are recorded so a
  bimodal page is visible.
- A warm-up render per page is discarded (module load, caches).
- CPU-only metrics (`busy_ms`, component self) are steadier than wall time on a shared box; the
  default gate is on **CPU busy and component self**, with wall render as a second, looser gate.
- The verdict says "regressed", "improved", "within noise" per metric; the job FAILS only on
  "regressed" past the budget, and only when the same metric is over the absolute floor.
- Repeat-on-regress: a page that fails is re-measured once before the verdict stands (cuts the
  false-positive rate of a single noisy burst).
- `--against base` (option 3 above) for the definitive answer when the artifact comparison is in
  doubt — the comment links to it.

## The PR comment

```
## Perf — 3 pages, 1 regression

| page | render (median) | CPU busy | seed | verdict |
|---|---|---|---|---|
| / | 41.2 → 41.9 ms (+2 %) | 31.5 → 31.8 | 100 KB | within noise |
| /products | 88.0 → 131.4 ms (+49 %) | 61 → 97 ms | 100 → 290 KB | **regressed** |
| /account | 23.1 → 22.4 ms | 17 → 16 | 0 | improved |

### /products — what moved
- `ProductCard` self 12 → 41 ms (×120 renders, was ×40) — src/lib/ProductCard.svelte:1
- `formatPrice` self 3 → 19 ms — src/lib/money.ts:8, called from ProductCard
- page seed 100 → 290 KB — an island now reads `$page.data` whole (seed shaping lost its keys)

Baseline: main @ 9f1e2d3 (2 h ago) · [full compare in the profiler](…) when a deploy is available
```

The "what moved" lines come straight from `compare_reports` rows + the findings (`component-repeat`,
`hot-function`, `seed-large`), so the comment and the profiler page never disagree.

## The GitHub Action

A thin wrapper; all logic is in the CLI so it runs identically locally (`pnpm ogygia perf`).

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4
- run: pnpm install && pnpm build
- uses: actions/download-artifact@v4          # baseline from main (may be absent on first run)
  with: { name: perf-snapshot, branch: main, if-no-artifact-found: warn }
- run: pnpm ogygia perf --pages perf/pages.json --baseline perf-snapshot.json --out perf-current.json --comment perf-comment.md
- uses: actions/upload-artifact@v4
  with: { name: perf-snapshot, path: perf-current.json }
- uses: marocchino/sticky-pull-request-comment@v2   # or gh api; one comment, updated per push
  with: { path: perf-comment.md }
```

`perf/pages.json` is the app's list: `{ "pages": ["/", "/products", "/account"], "runs": 7, "budget": { "render_pct": 8, "component_self_pct": 15, "seed_kb": 20, "floor_ms": 5 } }`.

## Amplify (and any deploy)

Amplify builds a preview per PR branch. The remote mode points the same CLI at that preview:

```
pnpm ogygia perf --url https://pr-42.<app>.amplifyapp.com --key "$OGYGIA_PROFILER_SECRET" --pages perf/pages.json …
```

What the deploy needs: the profiler on (`ogygia({ profiler: true })`, `OGYGIA_PROFILER_SECRET` set)
and the page-mode budget the profiler already respects on Lambda-backed hosts (30 s on Amplify —
`detect_request_budget_ms`). Cold starts are the trap: the first `/page` call on a fresh instance
pays module load; the CLI does an un-profiled warm request first and, on a `budget_note` in the
report (runs trimmed), retries once. The baseline is the same page on the base deploy (main's
preview URL), so both sides share the host's noise profile. Same snapshot, same compare, same
comment — only `mode: "remote"` and the `url` differ, which is what makes the design extensible: a
new target is a new way to obtain the JSON report, nothing downstream changes.

## Extensibility points

- **Targets**: `in-process` and `remote` today; a `docker` target (build the image, run it, hit it)
  fits the same `measure(url)` seam.
- **Metrics**: the snapshot schema is versioned; a new number (say bundle bytes from `e2e/bundle-size`,
  or the client boot numbers from `internal/bench/client-boot.mjs`) is one more key per page and one
  more row in the budget.
- **Reporters**: markdown comment, GitHub check, JSON. A Slack reporter is a function of the same
  `Verdict`.
- **Budgets per page**: `pages.json` entries can be objects `{ "path": "/products", "runs": 11, "budget": { "render_pct": 5 } }`.
- **The profiler UI as the deep view**: the comment can link `/__profiler/compare/<base-id>/<pr-id>`
  when a deploy keeps reports (a real server) — the remote mode already has the report ids.

## What exists already (reuse, do not rebuild)

- The JSON report (`report_json`): components, functions with stacks and locations, phases, the
  critical path, ogygia bytes, findings with fixes. The snapshot is a projection of it.
- `profiler/compare.ts` `compare_reports`: the row diff and the summary rows.
- `page_history`: the per-page series (a local run history for `ogygia perf --watch`).
- The page-mode budget + warm-up + redirect handling in `#record_page`: the remote mode is a client
  of it, nothing more.
- `internal/bench/server-cost.mjs`: the per-request cost bench — a different question (ogygia's
  overhead vs plain Kit), left as is; the CI tool is about the APP's pages.

## Build order (each step ships alone)

1. `ogygia perf --url … --pages … --out …` producing the snapshot from a running server (remote mode
   first: it is the smaller piece and it is what Amplify needs).
2. `compare` + budget + exit code + markdown (pure, tested on fixtures).
3. In-process mode (boot adapter-node, mount the profiler).
4. The GitHub workflow in this repo, measuring the playground's `/heavy` and `/bench-cms` on every PR.
5. `--against base` two-build mode.

## Open questions

- Should the in-process mode need `profiler: true` in the app config, or mount the profiler itself?
  (Mounting itself is friendlier; it means the handle exposes the seam behind an env flag like
  `OGYGIA_PERF=1`.)
- Component `calls` need the coverage pass, which doubles the render count per page; keep it (the
  "×N" is the best regression signal there is) but make it optional for the slow pages.
- Where the PR comment's deep link goes when the server is serverless and keeps no reports: attach
  the two `.ogp` files as artifacts and link the profiler's `/view` import.
