/**
 * The block registry — CMS `type` name → component. `import.meta.og.regions()` globs this folder at
 * build and emits one `with { region: 'raw' }` import per match (each block SSRs inline; its own
 * nested islands still wake), keyed by basename. Counter needs a wake schedule, not a raw region, so
 * it stays a manual import and spreads over the top — overriding the raw Counter the glob produced.
 */
import Counter from './Counter.svelte' with { wake: 'visible' };

export const registry = { ...import.meta.og.regions('./*.svelte'), Counter };
