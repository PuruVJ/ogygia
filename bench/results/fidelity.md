# Fidelity preflight

Every framework must render the same prose, heading structure, and exactly 5 `.bench-counter` widgets per post.

## small

- **ogygia**: counters=5 · prose chars=50819 · headings=11
- **sveltekit**: counters=5 · prose chars=50822 · headings=11
- **astro**: counters=5 · prose chars=50818 · headings=11
- **mochi**: counters=5 · prose chars=50818 · headings=11
- ~ prose near-match ogygia vs sveltekit (0.01% length drift — OK)
- ~ prose near-match ogygia vs astro (0.00% length drift — OK)
- ~ prose near-match ogygia vs mochi (0.00% length drift — OK)

## medium

- **ogygia**: counters=5 · prose chars=133227 · headings=29
- **sveltekit**: counters=5 · prose chars=133230 · headings=29
- **astro**: counters=5 · prose chars=133226 · headings=29
- **mochi**: counters=5 · prose chars=133226 · headings=29
- ~ prose near-match ogygia vs sveltekit (0.00% length drift — OK)
- ~ prose near-match ogygia vs astro (0.00% length drift — OK)
- ~ prose near-match ogygia vs mochi (0.00% length drift — OK)

## large

- **ogygia**: counters=5 · prose chars=410674 · headings=89
- **sveltekit**: counters=5 · prose chars=410677 · headings=89
- **astro**: counters=5 · prose chars=410673 · headings=89
- **mochi**: counters=5 · prose chars=410673 · headings=89
- ~ prose near-match ogygia vs sveltekit (0.00% length drift — OK)
- ~ prose near-match ogygia vs astro (0.00% length drift — OK)
- ~ prose near-match ogygia vs mochi (0.00% length drift — OK)

**PASS**
