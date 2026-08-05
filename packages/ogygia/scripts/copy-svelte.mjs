// Copy the Svelte-pipeline source files into dist/ (parallel paths). These are compiled by
// the CONSUMER's vite-plugin-svelte, not by tsdown: the wrapper components.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Only the .svelte COMPONENTS (with templates) need copying — tsdown can't compile those.
// The `.svelte.ts` runes MODULES (page-store, app-state) are TS-only: tsdown emits them as
// `.svelte.js` with the `$state` runes left intact, and the consumer's svelte pipeline compiles
// those (verified in dist). So they are NOT copied here.
const files = [
	'src/Island.svelte',
	'src/ServerIsland.svelte',
	'src/OgygiaRouter.svelte',
	'src/NestedProvider.svelte',
	'src/LakePlaceholder.svelte',
	'src/LakeBoundary.svelte',
	'src/LakeRegion.svelte',
	'src/OgygiaBoundary.svelte'
];

for (const rel of files) {
	const from = join(root, rel);
	const to = join(root, rel.replace(/^src\//, 'dist/'));
	mkdirSync(dirname(to), { recursive: true });
	cpSync(from, to);
	console.log('copied', rel, '->', to.replace(root, ''));
}
