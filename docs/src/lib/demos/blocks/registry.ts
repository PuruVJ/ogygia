/**
 * Block registry for the `<BlocksDemo>` — the same map a CMS would drive. Static blocks are plain
 * imports (they render inline, zero JS). The interactive block bakes its schedule with
 * `with { wake: 'load' }`, so `region()` wakes it and only pages that name it pull its chunk. Lives in
 * a `.ts` module because a held region's `wake:` mark is read here (a `.svelte` `wake:` mark is a
 * placed island, not a held one).
 */
import Hero from './Hero.svelte';
import Grid from './Grid.svelte';
import Feature from './Feature.svelte';
import CounterBlock from './CounterBlock.svelte' with { wake: 'load' };

export const registry = { Hero, Grid, Feature, CounterBlock };
