import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { content, folder, json } from '../src/content/index.js';
import type { GlobMap } from '../src/content/index.js';
import { outline } from '../src/content/site/outline.js';
import { numbered, type Convention } from '../src/content/convention.js';

const schema = v.object({ title: v.string() });

/** A folder() collection over a plain map (json format — a fixture page value is just `{ title }`). */
function corpus(map: GlobMap, opts: Parameters<typeof folder>[1] = {}) {
	return content({ loader: folder(map, { format: json, ...opts }), schema });
}
/** A doc-page fixture entry: `{ '…/+doc.svx': { title } }`. */
const doc = (id: string) => ({ title: id });

// ── numbered().verify — the blessed rules, unit level ──

describe('numbered().verify', () => {
	const verify = (segs: string[], opts = {}, meta?: Record<string, unknown>) =>
		numbered(opts).verify('guides', segs, meta as never);

	it('a directory with no prefixes is simply unordered — no issues', () => {
		expect(verify(['alpha', 'beta'])).toEqual([]);
	});
	it('clean numbering passes', () => {
		expect(verify(['01-a', '02-b', '03-c'])).toEqual([]);
	});
	it('mixed prefixed and unprefixed siblings is an error', () => {
		expect(verify(['01-a', 'beta']).join()).toMatch(/mixed prefixed and unprefixed/);
	});
	it('duplicate numbers are an error', () => {
		expect(verify(['01-a', '01-b']).join()).toMatch(/duplicate prefix number 1/);
	});
	it('inconsistent padding is an error (1- next to 01-)', () => {
		expect(verify(['1-a', '01-b']).join()).toMatch(/inconsistent prefix padding/);
	});
	it('pad option enforces an exact width', () => {
		expect(verify(['1-a', '2-b'], { pad: 2 }).join()).toMatch(/expected 2 digits/);
		expect(verify(['01-a', '02-b'], { pad: 2 })).toEqual([]);
	});
	it('gaps pass by default, fail with contiguous', () => {
		expect(verify(['01-a', '04-b'])).toEqual([]);
		expect(verify(['01-a', '04-b'], { contiguous: true }).join()).toMatch(/not contiguous/);
	});
	it('a +meta.json `ordered: false` exempts the directory', () => {
		expect(verify(['01-a', '01-b'], {}, { ordered: false })).toEqual([]);
	});
});

// ── folder() enforces the convention + derives ids/order/groups (the moved behavior) ──

describe('folder() convention', () => {
	it('duplicate numbers in a directory fail the read, named', async () => {
		const docs = corpus({
			'content/docs/00-start/01-install/+doc.svx': doc('install'),
			'content/docs/00-start/01-quick/+doc.svx': doc('quick'),
			'content/docs/01-guides/00-one/+doc.svx': doc('one')
		});
		await expect(outline(docs).tree()).rejects.toThrow(
			/ordering in start: duplicate prefix number 1/
		);
	});

	it('a clean corpus builds, ordered by NN-, ids/groups derived', async () => {
		const docs = corpus({
			'content/docs/00-start/01-quick/+doc.svx': doc('quick'),
			'content/docs/00-start/00-install/+doc.svx': doc('install'),
			'content/docs/01-guides/00-one/+doc.svx': doc('one')
		});
		const tree = await outline(docs).tree();
		expect(tree.length).toBe(2);
		const start = tree[0] as { label: string; items: { slug: string }[] };
		expect(start.label).toBe('Start');
		expect(start.items.map((i) => i.slug)).toEqual(['start/install', 'start/quick']); // NN- order
	});

	it('a +meta.json label overrides the title-cased default', async () => {
		const docs = corpus({
			'content/docs/00-data-state/00-a/+doc.svx': doc('a'),
			'content/docs/00-data-state/+meta.json': { label: 'Data & state' },
			'content/docs/01-guides/00-one/+doc.svx': doc('one')
		});
		const tree = await outline(docs).tree();
		expect((tree[0] as { label: string }).label).toBe('Data & state');
	});

	it('`ordered: false` in a directory +meta.json exempts it', async () => {
		const docs = corpus({
			'content/docs/00-log/2026-a/+doc.svx': doc('2026-a'),
			'content/docs/00-log/01-b/+doc.svx': doc('01-b'),
			'content/docs/00-log/+meta.json': { ordered: false },
			'content/docs/01-guides/00-one/+doc.svx': doc('one')
		});
		const tree = await outline(docs).tree();
		expect(tree.length).toBe(2); // builds despite mixed prefixed/unprefixed under log/
	});

	it('a whole custom convention reshapes structure (dot-ordering instead of dashes)', async () => {
		const dotted: Convention = {
			segment: (raw) => {
				const m = raw.match(/^(\d+)\.(.*)$/);
				return m
					? { slug: m[2], order: Number(m[1]) }
					: { slug: raw, order: Number.MAX_SAFE_INTEGER };
			},
			label: (slug) => slug.toUpperCase(),
			verify: () => []
		};
		const docs = corpus(
			{
				'content/docs/2.guide/2.b/+doc.svx': doc('b'),
				'content/docs/2.guide/1.a/+doc.svx': doc('a'),
				'content/docs/1.intro/1.x/+doc.svx': doc('x')
			},
			{ convention: dotted }
		);
		const tree = await outline(docs).tree();
		const group = tree.find((n) => (n as { label?: string }).label?.toLowerCase() === 'guide') as {
			items: { slug: string }[];
		};
		expect(group.items.map((i) => i.slug)).toEqual(['guide/a', 'guide/b']); // dot-order applied
	});
});
