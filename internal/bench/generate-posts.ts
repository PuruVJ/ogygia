// Generate three synthetic blog posts of increasing length (≈ upstream's ~8.8k / 23k / 71k words).
// Content is deterministic (seeded, no Math.random) and self-generated — we do NOT redistribute the
// upstream benchmark's article text. Each post is markdown with a handful of interactive components
// marked inline, so every framework hydrates the SAME number of islands regardless of prose length.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'posts');
mkdirSync(OUT, { recursive: true });

// A small fixed vocabulary → deterministic prose. Word count is what matters, not meaning.
const WORDS =
	'the quick island renders only what you mark so a mostly static page stays static and ships little javascript while the runtime waits and wakes each region on its own schedule when the reader scrolls or interacts'.split(
		' '
	);
let seed = 1234567;
const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const word = () => WORDS[next() % WORDS.length];

function paragraph(words) {
	const parts = [];
	for (let i = 0; i < words; i++) parts.push(word());
	let s = parts.join(' ');
	return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// Five interactive components spread through the post — the ISLAND count is constant across posts.
const WIDGET = (n) => `\n\n<Counter start={${n}} />\n\n`;

function post(targetWords) {
	let words = 0;
	let md = `# Benchmark post (${targetWords.toLocaleString()} words)\n\n`;
	let section = 0;
	let widgets = 0;
	while (words < targetWords) {
		if (words > (section + 1) * 800) {
			md += `\n\n## Section ${++section}\n\n`;
		}
		const n = 40 + (next() % 60);
		md += paragraph(n) + ' ';
		words += n;
		// Drop the 5 widgets at even intervals.
		if (widgets < 5 && words > ((widgets + 1) * targetWords) / 6) {
			md += WIDGET(widgets * 3);
			widgets++;
		}
	}
	while (widgets < 5) md += WIDGET(widgets++ * 3);
	return md;
}

const POSTS = [
	['small', 8800],
	['medium', 23000],
	['large', 71000]
];
for (const [name, words] of POSTS) {
	const md = post(words);
	writeFileSync(join(OUT, `${name}.md`), md);
	console.log(`  ${name}.md — ${md.split(/\s+/).length.toLocaleString()} words, ${md.length.toLocaleString()} chars`);
}
