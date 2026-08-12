import Hero from './blocks/Hero.svelte' with { region: 'raw' };
import Grid from './blocks/Grid.svelte' with { region: 'raw' };
import Feature from './blocks/Feature.svelte' with { region: 'raw' };
import CtaCounter from './blocks/CtaCounter.svelte' with { wake: 'load' };
export const registry = { Hero, Grid, Feature, CtaCounter };
export const tree = [
  { type: 'Hero', props: { title: 'Direct blocks', tagline: 'no content collection' } },
  { type: 'Grid', children: [
    { type: 'Feature', props: { title: 'A', body: 'one' } },
    { type: 'Feature', props: { title: 'B', body: 'two' } }
  ] },
  { type: 'CtaCounter', props: { start: 5 } }
];
