#!/usr/bin/env node
// Sync shared Counter + posts into a framework app so every target renders the same page.
// Usage: node bench/shared/sync.mjs <ogygia|sveltekit|mochi|astro>
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, '..');
const POSTS = ['small', 'medium', 'large'];
const kind = process.argv[2];
if (!kind || !['ogygia', 'sveltekit', 'mochi', 'astro'].includes(kind)) {
	console.error('usage: node shared/sync.mjs <ogygia|sveltekit|mochi|astro>');
	process.exit(1);
}

const root = join(BENCH, 'frameworks', kind);

const scripts = {
	ogygia: "import Counter from '$lib/Counter.svelte' with { wake: 'load' };",
	sveltekit: "import Counter from '$lib/Counter.svelte';",
	mochi: "import Counter from '../Counter.svelte';",
	astro: "import Counter from '../../components/Counter.jsx';"
};

function transformCounters(md) {
	if (kind === 'mochi') {
		return md.replace(/<Counter\s+start=\{(\d+)\}\s*\/>/g, '<Counter mochi:hydrate start={$1} />');
	}
	if (kind === 'astro') {
		return md.replace(/<Counter\s+start=\{(\d+)\}\s*\/>/g, '<Counter client:load start={$1} />');
	}
	return md;
}

function wrap(md) {
	const body = transformCounters(md);
	const importLine = scripts[kind];
	if (kind === 'astro') {
		return `---\nlayout: ../../layouts/Post.astro\n---\n\n${importLine}\n\n${body}`;
	}
	if (kind === 'mochi') {
		// Wrap in <main> so shared post.css applies the same layout as the other apps.
		return `<script>\n\t${importLine}\n</script>\n\n<main>\n\n${body}\n\n</main>\n`;
	}
	return `<script>\n\t${importLine}\n</script>\n\n${body}`;
}

// Counter
if (kind === 'astro') {
	const dest = join(root, 'src', 'components');
	mkdirSync(dest, { recursive: true });
	copyFileSync(join(HERE, 'preact', 'Counter.jsx'), join(dest, 'Counter.jsx'));
} else if (kind === 'mochi') {
	mkdirSync(join(root, 'src'), { recursive: true });
	copyFileSync(join(HERE, 'svelte', 'Counter.svelte'), join(root, 'src', 'Counter.svelte'));
} else {
	const dest = join(root, 'src', 'lib');
	mkdirSync(dest, { recursive: true });
	copyFileSync(join(HERE, 'svelte', 'Counter.svelte'), join(dest, 'Counter.svelte'));
}

// Shared CSS → public/static
const cssSrc = join(HERE, 'post.css');
if (kind === 'astro' || kind === 'mochi') {
	const pub = join(root, 'public');
	mkdirSync(pub, { recursive: true });
	copyFileSync(cssSrc, join(pub, 'post.css'));
} else {
	const st = join(root, 'static');
	mkdirSync(st, { recursive: true });
	copyFileSync(cssSrc, join(st, 'post.css'));
}

// Posts
for (const id of POSTS) {
	const src = join(BENCH, 'posts', `${id}.md`);
	if (!existsSync(src)) {
		console.error(`missing ${src} — run node generate-posts.mjs first`);
		process.exit(1);
	}
	const wrapped = wrap(readFileSync(src, 'utf8'));
	if (kind === 'astro') {
		const dir = join(root, 'src', 'pages', 'posts');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.mdx`), wrapped);
	} else if (kind === 'mochi') {
		const dir = join(root, 'src', 'posts');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.md`), wrapped);
	} else {
		const dir = join(root, 'src', 'routes', 'posts', id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '+page.md'), wrapped);
		// Explicit csr=false so ogygia's keepalive injects (every node own-csr must be false).
		if (kind === 'ogygia') {
			writeFileSync(
				join(dir, '+page.ts'),
				"export const csr = false;\nexport const prerender = true;\n"
			);
		}
	}
}

console.log(`synced shared Counter + posts → frameworks/${kind}`);
