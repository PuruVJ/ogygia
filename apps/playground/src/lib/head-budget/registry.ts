// A Builder / CMS block registry: six marked blocks, the page renders ONE of them by reference.
// e2e/head-budget asserts the other five never reach the page (no stylesheet, no chunk hint).
import BlockA from './BlockA.svelte' with { wake: 'visible' };
import BlockB from './BlockB.svelte' with { wake: 'visible' };
import BlockC from './BlockC.svelte' with { wake: 'visible' };
import BlockD from './BlockD.svelte' with { wake: 'visible' };
import BlockE from './BlockE.svelte' with { wake: 'visible' };
import BlockF from './BlockF.svelte' with { wake: 'visible' };
// PLAIN blocks (no `with`): server-rendered, never regions. The page node's client graph is the only
// thing that links their CSS on a csr=false page, so all three shapes must keep their edge there: a
// direct import, a name from a plain barrel, and a re-export.
import BlockPlain from './BlockPlain.svelte';
import { BlockPlainBarrel } from './plain-barrel';
export { default as BlockPlainReexport } from './BlockPlainReexport.svelte';

export const blocks: Record<string, unknown> = {
	a: BlockA,
	b: BlockB,
	c: BlockC,
	d: BlockD,
	e: BlockE,
	f: BlockF,
	plain: BlockPlain,
	'plain-barrel': BlockPlainBarrel
};

export function block(type: string): unknown {
	return blocks[type];
}

export default blocks;
