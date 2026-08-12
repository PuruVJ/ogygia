/**
 * Blocks collection with a SERVER-ONLY registry: this module is imported exclusively by
 * `+page.server.ts`, so no page's client graph ever sees these components. That is the deliberate
 * stress case — none of these components' CSS can be statically linked into any page stylesheet.
 *
 * Registry marks: static blocks are `region: 'raw'` (HTML only, zero JS); the counter bakes
 * `wake: 'load'` (pages naming it pull exactly one hydrate chunk).
 */
import { content, blocks } from 'ogygia/content';
import Hero from './Hero.svelte' with { region: 'raw' };
import Grid from './Grid.svelte' with { region: 'raw' };
import Feature from './Feature.svelte' with { region: 'raw' };
import CtaCounter from './CtaCounter.svelte' with { wake: 'load' };
import Unused from './Unused.svelte' with { region: 'raw' };

export const pages = content({
	loader: blocks(import.meta.glob('./pages/*.json'), { Hero, Grid, Feature, CtaCounter, Unused })
});
