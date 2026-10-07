# Load scheduler — one queue for every download ogygia starts on its own

Status: BUILT 2026-10-07, uncommitted (user reviews the working tree). Code:
`packages/ogygia/src/runtime/load-scheduler.ts`.

## Why

Field report (country home pages): once ogygia's wake gate (DOMContentLoaded + a painted frame)
opened, every above-the-fold and one-screen-ahead island started downloading while the hero image
(`fetchpriority="high"`, the LCP) was still in flight: 206 requests / 888 KB beside it, hero
1.19 s → 2.27 s, LCP ~1 s worse. It had been hidden by a blocking third-party script that delayed
DOMContentLoaded. Priority hints alone did nothing in the lab (Chrome's throttling splits bandwidth
evenly); waiting for the hero recovered most of it.

Root cause, architecturally: each download path picked its own moment (island code: the wake gate;
hole HTML: at once; hole prefetch: its schedule; hover warm: at once; router prefetch: at once) and
nothing capped background work in flight. Same shape as the DOM ownership problem: decided per
caller.

## Model

- **Classes** by who waits: `user` (a gesture: interaction wake, hover warm, a click-time
  navigation; `preload()` keeps its own path) → `visible` (on screen) → `ahead` (off screen,
  `idle`, one screen ahead, a hole `prefetch`) → `speculative` (router page prefetch + its module
  warm).
- **Gate** `critical_settled()`: painted document AND every eager `img[fetchpriority=high]` /
  `link[rel=preload][fetchpriority=high]` arrived or failed — or first `pointerdown`/`keydown`, or
  `CRITICAL_CAP_MS` (2500). Island CODE and every background class wait for it; visible CONTENT
  (a hole's HTML on screen) and `user` never do. On a Kit-hydrated document nothing waits on it
  (Kit's own start sets the pace); the window still applies.
- **Window**: `BACKGROUND_WINDOW` (3) background downloads in flight, `ahead` before `speculative`.
- **Priority**: `user` high, `visible` auto, background low — on `fetch(…, { priority })` and the
  island graph's `<link rel=modulepreload fetchpriority>` (the island `import()` reuses it).
- **Promotion**: a class given as a getter is re-read on every drain (and on scroll while such an
  entry waits): an island scrolling into view moves from `ahead` to `visible`. `ticket.promote()`
  lifts by hand (a click on a link whose prefetch still waits).

## Wired

- `core.ts` `#hydrate` / `#live_hydrate`: island code (`kind: 'code'`, class from the viewport, or
  `user` after an interaction wake). `#arm` lost its own DOMContentLoaded gate and its `loads_code`
  flag (the download decides now).
- `core.ts` holes: `#frame_fetcher(endpoint, revalidate, cls)` → `#fetch_region` (the old body, plus
  `priority`): wake = viewport / `user`, prefetch = `ahead`. The server gate (3 concurrent) still caps
  what one page asks of the origin.
- `region-endpoint-url.ts` `warm_island_module(entry, base, cls = 'speculative')`; interaction's
  hover warm passes `user`.
- `router-nav.ts` `fetch_page`: a `prefetch` waits for a `speculative` slot (low priority); a `nav`
  joining a queued prefetch promotes it to `user`. Reached through `slots.boot.load_slot` (lazy-chunk
  rule).
- Observability: devtools `load.started` (class, kind, waited) and `load.critical` (outcome);
  session findings `loads-held` (info) and `critical-cap` (warn); the profiler beacon records
  `paints.held`, and the LCP explanation names a hero that outran the cap.

## Not done (deliberately)

- Server-side hole fetch preloads (`<link rel=preload as=fetch>` for `when: load` holes) keep the
  default priority: the server can't see the viewport, and those holes asked to load at once.
- The runtime's own modulepreloads in the HTML: it must boot early (it defines the regions).
- `preload(region)` (public, client): an explicit call is intent; it keeps its own direct fetch.

## Tests

- `test/browser/load-scheduler.test.ts`: priorities + viewport class; code waits for the hero,
  gestures and visible content don't; first input releases; no marked resource; the window and
  ranking; viewport promotion and `promote()`.
- `e2e/load-scheduler.spec.ts` (+ `apps/playground/src/routes/load-scheduler`): the hero held →
  no island entry requested, all after it arrives; a click while held wakes at once; a hero that
  never arrives holds no longer than the cap. On the old core: island entries at ~30 ms while the
  hero is held — the field bug.
