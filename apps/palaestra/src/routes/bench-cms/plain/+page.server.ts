// The no-ogygia twin of ../+page.server.ts: same data, same components, rendered unmarked.
import { page_tree } from '$lib/bench/data';

export const prerender = false;
export const load = () => page_tree();
