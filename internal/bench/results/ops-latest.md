# ogygia core ops/sec

Per-island / per-nav hot functions, bundled from source and run in real Chromium. 2026-08-16T07:53:35.679Z, commit `1ce2594`. Best-of-5 over a 400ms window each. Sorted slowest-first (the hottest to optimize).

```
devalue_parse_complex         751k ops/s    1331.5 ns/op
region_ssr_truncated          1.4M ops/s     707.1 ns/op
frameAddress                  1.9M ops/s     518.1 ns/op
island_module_url_rel         2.3M ops/s     441.2 ns/op
devalue_parse_small           6.3M ops/s     158.8 ns/op
region_is_vacant              7.5M ops/s     133.0 ns/op
devalue_parse_empty          18.6M ops/s      53.8 ns/op
region_schedule              43.7M ops/s      22.9 ns/op
is_deferred                  63.8M ops/s      15.7 ns/op
region_hydrate_schedule      65.7M ops/s      15.2 ns/op
is_awake                     67.7M ops/s      14.8 ns/op
region_remount               76.9M ops/s      13.0 ns/op
island_module_url_abs       213.9M ops/s       4.7 ns/op
```
