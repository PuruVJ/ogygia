// SERVER-COST BENCH (internal/bench/server-cost.mjs): a large CMS page shape rendered with ogygia
// islands. The twin at ./plain renders the SAME components unmarked (no islands, no seed, no props)
// so the difference between the two routes is ogygia's per-request cost, nothing else.
import { page_tree } from '$lib/bench/data';

export const prerender = false;
export const load = () => page_tree();
