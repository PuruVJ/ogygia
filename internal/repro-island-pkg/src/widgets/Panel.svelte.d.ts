// A distributed component SHIPS ITS TYPES — the sibling `.svelte.d.ts` is how a package's
// `.svelte` file resolves for consumers under svelte-check (part of the packaging story the
// fixture demonstrates, alongside the `ogygia.files` declaration).
import type { Component } from 'svelte';

declare const Panel: Component<Record<string, never>>;
export default Panel;
