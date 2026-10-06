// A plain helper between a page and the registry (`+page.svelte` → factory.ts → registry.ts): the
// csr=false client leg must treat the registry behind it exactly like a direct import.
import { block } from './registry';

export function component_for(type: string): unknown {
	return block(type);
}
