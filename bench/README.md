# ogygiaBench

A reproducible port of **[Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark)**,
kept in-repo so we can measure ogygia against other approaches on every change.

> Full credit to **[@khromov](https://github.com/khromov)** — the methodology, the framework line-up
> (Astro/Iles/Mochi islands vs SvelteKit whole-page hydration), the three-post size-vs-length idea,
> and the measurement approach are all his. This is his benchmark, adapted to run here on **latest
> tooling** (the legacy "SvelteKit 2022 / Svelte 3" target is dropped) with **ogygia added**.

## What it measures

For a blog post containing interactive components, how much client JS ships — and crucially, whether
it **grows with post length**. Islands ship a flat, tiny payload regardless of how long the prose is;
whole-page hydration scales with the whole document.

Per framework × post it records (same as upstream):

- **JS size** — raw + gzip -9, summed across every `Script` request (fetched with `accept-encoding:
  identity` so the number is independent of how each server serves it).
- **HTML size** — raw + gzip -9.
- **Lighthouse** (mobile, simulated throttling, `performance` only): score, LCP, CLS, TBT.
- **Script eval time** (`bootup-time`) and **DOM element count**.

Three posts of increasing length exercise the growth curve. Content is **synthetically generated**
(`generate-posts.mjs`) to hit target word counts — we don't redistribute upstream's article text.

## Frameworks

| id          | approach                        | tooling            |
| ----------- | ------------------------------- | ------------------ |
| `ogygia`    | Svelte 5 islands (this repo)    | SvelteKit, latest  |
| `sveltekit` | Svelte 5 whole-page hydration   | SvelteKit, latest  |
| `astro`     | Preact islands                  | Astro, latest      |
| `mochi`     | Svelte 5 islands ([mochi.fast]) | Mochi, latest      |

[mochi.fast]: https://mochi.fast/

Astro (and some others) pin older Node, so the whole thing runs in **Docker** for a hermetic,
reproducible environment — one image, one Node, one Chrome.

## Run

```bash
# reproducible (recommended): everything in Docker
docker compose -f bench/docker-compose.yml up --build

# or locally (Node 22+, pnpm, bun, Chrome/Chromium):
pnpm run bench:build          # generate posts, pack ogygia, build all frameworks
# start mochi in another terminal:
cd bench/frameworks/mochi && PORT=3335 bun run start
pnpm run bench:run            # fidelity + Lighthouse → bench/results/latest.md
```

Results land in `bench/results/` (markdown tables + JSON). See `IMPLEMENTATION.md` for the full spec.

Framework apps are **not** pnpm workspace members — each has its own install.

## Feature matrices

Numbers are only half the story — what you can actually build matters too. Two comparisons: the
framework a Svelte user is likely on today (SvelteKit), and the closest islands peer (Mochi).

### vs SvelteKit — islands *on top of* Kit

ogygia is a SvelteKit plugin, so you keep everything Kit gives you and add islands. The difference is
what ships to the browser.

| Capability | SvelteKit (whole-page hydration) | ogygia (islands) |
| --- | :---: | :---: |
| SSR / prerender | ✅ | ✅ |
| Runs on SvelteKit | ✅ | ✅ |
| Ships JS for the whole page | ✅ (hydrates everything) | ❌ — only components you mark |
| Client JS grows with post length | ✅ | ❌ **flat** |
| Per-component wake timing (`load`/`idle`/`visible`/`interaction`/`media`) | ❌ | ✅ |
| Server islands (defer render to an endpoint) | ✅ | ✅ |
| Remote functions | ✅ | ✅ (uses Kit's) |
| SPA router | ✅ | ✅ (opt-in `<Router/>`) |
| `$app/state` + `$app/navigation` inside components | ✅ | ✅ (inside islands) |
| Form actions / progressive enhancement | ✅ | ✅ |
| Markdown content collections | ➖ (add mdsvex yourself) | ✅ built-in |

### vs Mochi — islands head-to-head

Both are Svelte 5 islands. ogygia trades a little more baseline runtime for a much larger feature
surface (server islands, held/live/frozen regions, Kit integration). Mochi is leaner and simpler.
Mochi's column reflects the version measured in this benchmark; `?` = not verified.

| Capability | Mochi | ogygia |
| --- | :---: | :---: |
| Svelte 5 islands | ✅ | ✅ |
| Markdown (mdsvex) | ✅ | ✅ |
| Built on SvelteKit (Kit ecosystem, adapters, hooks) | ❌ (own framework) | ✅ |
| Multiple wake strategies (idle / visible / interaction / media) | ? | ✅ |
| Server islands (defer render) | ? | ✅ |
| Held regions — `region()` values you place like data | ❌ | ✅ |
| Frozen regions (lakes) | ❌ | ✅ |
| Live / streaming regions | ? | ✅ |
| Transportable (devalue-encoded) island props | ? | ✅ |
| SPA router | ? | ✅ |
| Kit remote functions | ❌ | ✅ |
| Runtime JS (this benchmark, brotli) | leaner | ~a few KB more, flat |

> Honesty note: ogygia's runtime is larger than Mochi's — that's the cost of the extra surface. See
> the size table above for the current numbers; we track it in `bundle-size.snapshot.json` so it can
> only shrink over time.
