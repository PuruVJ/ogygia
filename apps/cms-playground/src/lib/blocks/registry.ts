/**
 * The block registry — CMS `type` name → component. Held-region imports: each block SSRs inline;
 * only blocks with a `wake` schedule ship any client JS (Counter wakes on visibility, everything
 * else is HTML-only).
 */
import Hero from './Hero.svelte' with { region: 'raw' };
import Prose from './Prose.svelte' with { region: 'raw' };
import Callout from './Callout.svelte' with { region: 'raw' };
import Code from './Code.svelte' with { region: 'raw' };
import Counter from './Counter.svelte' with { wake: 'visible' };

export const registry = { Hero, Prose, Callout, Code, Counter };
