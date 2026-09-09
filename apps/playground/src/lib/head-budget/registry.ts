// A Builder / CMS block registry: six marked blocks, the page renders ONE of them by reference.
// e2e/head-budget asserts the other five never reach the page (no stylesheet, no chunk hint).
import BlockA from './BlockA.svelte' with { wake: 'visible' };
import BlockB from './BlockB.svelte' with { wake: 'visible' };
import BlockC from './BlockC.svelte' with { wake: 'visible' };
import BlockD from './BlockD.svelte' with { wake: 'visible' };
import BlockE from './BlockE.svelte' with { wake: 'visible' };
import BlockF from './BlockF.svelte' with { wake: 'visible' };

export const blocks: Record<string, unknown> = {
	a: BlockA,
	b: BlockB,
	c: BlockC,
	d: BlockD,
	e: BlockE,
	f: BlockF
};

export function block(type: string): unknown {
	return blocks[type];
}

export default blocks;
