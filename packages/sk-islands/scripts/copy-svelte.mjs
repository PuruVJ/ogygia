// Copy the Svelte-pipeline source files into dist/ (parallel paths). These are compiled by
// the CONSUMER's vite-plugin-svelte, not by tsdown: the 3 wrapper components and the runes
// module `shims/remote-client.svelte.js`.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
	'src/Island.svelte',
	'src/ServerIsland.svelte',
	'src/ClientRouter.svelte',
	'src/NestedProvider.svelte',
	'src/shims/remote-client.svelte.js'
];

for (const rel of files) {
	const from = join(root, rel);
	const to = join(root, rel.replace(/^src\//, 'dist/'));
	mkdirSync(dirname(to), { recursive: true });
	cpSync(from, to);
	console.log('copied', rel, '->', to.replace(root, ''));
}
