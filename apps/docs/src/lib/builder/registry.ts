/**
 * Block registry for the Builder.io demo. Static blocks are plain imports — they render inline, zero
 * JS. An interactive block bakes its schedule with `with { wake: … }`, so `region()` wakes it and only
 * a page that names it pulls its chunk. The KEYS here are the component names you register in Builder's
 * editor (`component.name`).
 */
import Hero from '$lib/demos/blocks/Hero.svelte';
import Grid from '$lib/demos/blocks/Grid.svelte';
import Feature from '$lib/demos/blocks/Feature.svelte';
import CounterBlock from '$lib/demos/blocks/CounterBlock.svelte' with { wake: 'load' };

export const registry = { Hero, Grid, Feature, CounterBlock };
