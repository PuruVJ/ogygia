// A block registry the outer island renders from at render time (e2e/nested-css): its marked block
// is a nested island the outer island never imports itself.
import RegistryInner from './RegistryInner.svelte' with { wake: 'visible' };

export const blocks: Record<string, unknown> = { inner: RegistryInner };
