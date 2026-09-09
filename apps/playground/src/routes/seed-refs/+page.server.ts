// SEED REFERENCES reproduction (e2e/seed-refs.spec.ts): the Schneider shape. The load returns a
// CMS-like tree; the page hands each block island its slice of that tree as props — some by
// identity, some CLONED the way a CMS SDK does — and one island reads `$page`, so the seed ships.
// Without references the same JSON crosses twice (seed + props); with them the props become paths.
const LOREM =
	'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

export type Block = {
	id: string;
	kind: 'hero' | 'card' | 'text';
	title: string;
	body: string;
	tags: string[];
	meta: { author: string; updated: string; weight: number; links: { href: string; label: string }[] };
};

function block(i: number): Block {
	return {
		id: `block-${i}`,
		kind: i === 0 ? 'hero' : i % 2 ? 'card' : 'text',
		title: `Block ${i}: ${LOREM.slice(0, 40)}`,
		// unique per block: devalue dedupes repeated strings, which would shrink the seed unrealistically
		body: `${LOREM}(block ${i}) `.repeat(6),
		tags: ['one', 'two', `tag-${i}`],
		meta: {
			author: 'cms',
			updated: '2026-09-09',
			weight: i,
			links: [
				{ href: `/link/${i}/a`, label: `Link ${i} A` },
				{ href: `/link/${i}/b`, label: `Link ${i} B` }
			]
		}
	};
}

export const load = () => {
	const blocks: Block[] = Array.from({ length: 12 }, (_, i) => block(i));
	return {
		catalog: { title: 'Seed refs catalog', blocks },
		// something a $page-reading island shows, to prove the seed is live
		greeting: 'hello from page.data'
	};
};
