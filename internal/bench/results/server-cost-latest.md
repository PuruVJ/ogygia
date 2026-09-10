# server-cost — ogygia's per-request overhead (2026-09-10)

`node internal/bench/server-cost.mjs 300 4` — the playground's `/bench-cms` (21 islands: a header
island with a ~300 KB config prop outside `page.data`, one `$page` reader, twenty block islands fed
slices of a ~250 KB `page.data` tree) against `/bench-cms/plain` (the same components, unmarked).
300 requests × 4 concurrent per route, two rounds; vite preview under `--cpu-prof`.

| | plain | islands (before) | islands (after) |
| --- | --- | --- | --- |
| HTML | 194 KB | 683 KB | 627 KB |
| p50 | 15–18 ms | 46 ms (**+28**) | 28–32 ms (**+12 to +17**, three runs) |
| p95 | 20–24 ms | 65 ms (+41) | 42–52 ms (+21 to +30) |
| RSS over 1,200 requests | flat | flat | flat |

Non-idle CPU over the 1,200 requests: ~10.1 s before, ~6.7 s after. devalue's `stringify` (2.8 s
before) is gone from the seed/props path (JSON lane). What remains in ogygia's own code, after:
`fnv1a` 454 ms (fingerprint over the canonical props text), `locate` 247 ms (the one flatten of
Kit's rope), `measure` 216 ms (the one seed/props walk), `plan_props_wire` 165 ms (native
`JSON.stringify`), the transform body 255 ms.

Kit's own, paid by both routes: `devalue.uneval` of every load node on csr=false (1.4 s, the result
is discarded) and the ETag `hash()` over the whole HTML (0.8 s) — ~1.8 ms per request here.
