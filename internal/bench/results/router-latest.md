# ogygia router benchmark

Real Chromium (Playwright), production playground build, local preview server. 2026-08-16T07:31:37.622Z, commit `1ce2594`, n=15 per timing scenario unless noted. Local network ≈ zero RTT — deployed cold-nav numbers grow by your network latency; warm/prefetched numbers do not.

## boot

```
TTFB              p50 1.7ms  p90 2.1ms  (min 1.1 max 3.3 n=12)
DOMContentLoaded  p50 21.4ms  p90 23.2ms  (min 20.3 max 30.3 n=12)
load event        p50 21.5ms  p90 23.4ms  (min 20.5 max 30.5 n=12)
islands settled   p50 23.6ms  p90 25.5ms  (min 22.7 max 32.5 n=12)   (all wake:load islands hydrated)
script eval       p50 4.3ms  p90 4.4ms  (min 3.8 max 4.4 n=12)   (total ScriptDuration)
JS payload        67.5 kB transfer / 146.9 kB decoded across 28 files; HTML 11.2 kB
```

## soft-nav-cold

```
click → body swapped     p50 12.1ms  p90 13.4ms  (min 8.0 max 13.9 n=15)
click → first island up  p50 29.8ms  p90 32.8ms  (min 22.8 max 33.3 n=15)
click → all islands up   p50 33.9ms  p90 36.9ms  (min 29.7 max 38.5 n=15)
main-thread blocking     p50 0.0ms  p90 0.0ms  (min 0.0 max 0.0 n=15)   (long-task time >50ms during nav)
```

## soft-nav-warm

```
click → body swapped     p50 5.5ms  p90 5.7ms  (min 5.1 max 6.0 n=15)
click → first island up  p50 19.7ms  p90 20.5ms  (min 18.3 max 21.0 n=15)
click → all islands up   p50 20.8ms  p90 21.8ms  (min 19.5 max 21.8 n=15)
```

## hard-nav

```
navigationStart → DOMContentLoaded  p50 5.1ms  p90 5.4ms  (min 4.5 max 9.9 n=15)
navigationStart → load              p50 5.2ms  p90 5.5ms  (min 4.6 max 10.1 n=15)
vs soft nav: warm swap is 0.9× faster, cold swap 0.4× faster (p50)
```

## prefetch-runway

```
hover → HTML fully cached  p50 2.1ms  p90 2.2ms  (min 1.8 max 2.3 n=15)
any hover longer than this makes the next click swap from cache (zero network)
```

## view-transitions

```
VT on   click → swap  p50 5.3ms  p90 5.7ms  (min 3.8 max 5.8 n=12)
VT off  click → swap  p50 4.6ms  p90 4.8ms  (min 4.4 max 4.9 n=12)   (prefers-reduced-motion)
VT overhead ≈ 0.7ms p50 (snapshot + animation frame)
```

## back-forward

```
back (popstate → swap)     p50 11.4ms  p90 14.6ms  (min 9.8 max 14.8 n=15)
forward (popstate → swap)  p50 8.9ms  p90 10.3ms  (min 3.9 max 10.7 n=15)   (/about still in 8s page cache → no network)
```

## wake-visible

```
scroll → first visible island hydrated  p50 6.9ms  p90 8.1ms  (min 6.1 max 9.1 n=15)
scroll → all visible islands hydrated   p50 8.4ms  p90 9.5ms  (min 7.1 max 9.7 n=15)
```

## wake-interaction

```
click → island hydrated        p50 3.8ms  p90 4.1ms  (min 3.5 max 4.1 n=15)   (module fetched on demand)
click → replayed click applied p50 4.2ms  p90 4.6ms  (min 3.9 max 4.6 n=15)   (counter shows 1 — the click was not lost)
```

## weave

```
click → swap            p50 9.1ms  p90 11.6ms  (min 8.8 max 11.6 n=5)   (swap NOT blocked by 3s server delays)
click → first frame in  p50 1022ms  p90 2538ms  (min 1019 max 2538 n=5)   (server delay ≥1000ms is intentional)
click → all frames in   p50 3021ms  p90 5038ms  (min 2025 max 5038 n=5)   (slowest region is 3000ms)
island-endpoint requests: 5 POST (batch) + 4 GET across 5 runs — UNEXPECTED
```

## races

```
first click → settled on final page  p50 123ms  p90 126ms  (min 117 max 126 n=10)
correct final page 10/10 ✓; 20 stale in-flight fetches aborted across runs
```

## throughput

```
per-nav swap  p50 7.8ms  p90 8.1ms  (min 5.9 max 9.0 n=40)   (page cache warm after first round trip)
sustained     116.3 navs/sec over 0.3s
```

## memory

```
JS heap   1242.9 kB → 1797.3 kB (30 navs) → 1870.8 kB (60 navs)
  per-nav Δheap: 10.5 kB/nav overall, 2.5 kB/nav in the 2nd half
DOM nodes 414 → 732 → 732  (resting on / each time)
listeners 16 → 16   documents 1 → 1
verdict: BOUNDED — nodes plateau, no per-nav accumulation, no detached document retained ✓
```

## cpu-throttle-4x

```
cold  click → swap p50 22.6ms  p90 26.2ms  (min 16.0 max 26.2 n=8);  all islands p50 90.2ms  p90 97.2ms  (min 76.1 max 97.2 n=8)
warm  click → swap p50 13.3ms  p90 13.8ms  (min 12.8 max 13.8 n=8);  all islands p50 55.5ms  p90 56.9ms  (min 52.7 max 56.9 n=8)
```

## network-slow-4g

```
cold click (nothing prefetched)  → swap p50 453ms  p90 455ms  (min 445 max 455 n=8);  all islands p50 1047ms  p90 1049ms  (min 1013 max 1049 n=8)
warm click (hover-prefetched)    → swap p50 11.0ms  p90 11.8ms  (min 7.6 max 11.8 n=8);  all islands p50 30.6ms  p90 37.6ms  (min 18.1 max 37.6 n=8)
click → all-islands-interactive is 34.2× faster warm vs cold on Slow-4G (p50)
this is the real-world payoff of HTML prefetch + island-module warming; on localhost it is ~0
```

## visible-slow-4g

```
scroll → first visible island hydrated  p50 1.9ms  p90 2.1ms  (min 1.0 max 2.1 n=8)   (module already warmed at idle)
without idle warming this pays a full cold chunk fetch on scroll (~410ms p50 on this link)
```

Real page/console errors during the whole run: **0**

Unhandled "Transition was skipped" rejections: **0** — cosmetic. The router awaits `viewTransition.updateCallbackDone.catch()` but never attaches a catch to `.ready`/`.finished`, so interrupting an in-flight view transition (rapid nav) leaks an unhandled rejection. No user-visible effect; a one-line `t.finished.catch(()=>{})` silences it.
