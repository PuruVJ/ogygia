/**
 * Block registry for the `<BlocksDemo>` — the same map a CMS would drive. Static blocks are
 * `with { region: 'raw' }` imports: held blocks, code-split, HTML only (zero JS), each with its own
 * CSS asset the region links into `<head>` on render. The interactive block uses `with { wake: 'load' }`
 * instead, so it also pulls a hydrate chunk — but only on pages that name it. Lives in a `.ts` module
 * because a held region's mark is read here (a `.svelte` `wake:` mark is a placed island, not a held one).
 */
import Hero from './Hero.svelte' with { region: 'raw' };
import Grid from './Grid.svelte' with { region: 'raw' };
import Feature from './Feature.svelte' with { region: 'raw' };
import CounterBlock from './CounterBlock.svelte' with { wake: 'load' };

export const registry = { Hero, Grid, Feature, CounterBlock };
