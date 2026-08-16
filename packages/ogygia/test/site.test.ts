import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { content } from '../src/content/index.js';
import type { Heading, Source, SourceEntry } from '../src/content/index.js';
// Import from the submodules, not the barrel — the barrel re-exports `.svelte` chrome that vitest
// (no svelte plugin here) can't parse.
import { outline, pick } from '../src/content/site/outline.js';
import { sitekit as sitekitRaw, mountBase } from '../src/content/site/site.js';
import { links } from '../src/content/site/checks.js';
import type { NavGroup, NavLeaf, NavTree } from '../src/content/site/types.js';

// Test shim: keep the positional call style in the fixtures; the real API is `mint_site({ outline, …opts })`.
const mint_site = (
	outlineArg: Parameters<typeof sitekitRaw>[0]['outline'],
	opts: Partial<Parameters<typeof sitekitRaw>[0]> = {}
) => sitekitRaw({ outline: outlineArg, ...opts });
import { remarkLinks } from '../src/content/markdown/remark-links.js';
import { rehypeOverrides, SLOT_TAG } from '../src/content/markdown/rehype-overrides.js';
import { build_docs, orama_engine, split_sections, strip_prose } from '../src/content/site/search.js';

type Meta = { headings: Heading[] };

/** In-memory source for fixtures (the lib no longer ships `fromArray`). Optional `groups` supplies
 *  the section-decoration facet (folder()/CMS provide it in production). */
function fromArray(entries: SourceEntry<Meta>[], groupMap?: Map<string, { label?: string }>): Source<Meta> {
	const map = new Map(entries.map((e) => [e.id, e]));
	return {
		get: async (id) => map.get(id) ?? null,
		refs: async () => entries.slice(),
		...(groupMap ? { groups: async () => groupMap } : {})
	};
}

/** Sibling order (per id level) read off a fixture's `NN-` filePath — mirrors what `folder()` computes. */
function orderOf(id: string, filePath: string): number[] {
	const parts = filePath.replace(/\\/g, '/').split('?')[0].split('/').filter(Boolean);
	const last = parts[parts.length - 1] ?? '';
	if (/^(\+doc|index)\./.test(last) || /^\+/.test(last)) parts.pop();
	else if (parts.length) parts[parts.length - 1] = last.replace(/\.[^.]+$/, '');
	const idDepth = id.split('/').filter(Boolean).length;
	const tail = parts.slice(-idDepth);
	return tail.map((seg) => {
		const m = seg.match(/^(\d+)-/);
		return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
	});
}

const docSchema = v.object({
	title: v.string(),
	summary: v.optional(v.string(), ''),
	badge: v.optional(v.string()),
	related: v.optional(v.array(v.string()), [])
});

/** A page fixture as the source yields it — clean id + NN- filePath + derived `order` (like folder()). */
function page(id: string, filePath: string, data: Record<string, unknown>, headings: Heading[] = []): SourceEntry<Meta> {
	return { id, filePath, order: orderOf(id, filePath), data, meta: { headings } };
}

function docsFixture() {
	return content({
		loader: fromArray([
			page('start/install', 'content/docs/00-start/00-install/+doc.svx', { title: 'Install' }),
			page('start/first-island', 'content/docs/00-start/01-first-island/+doc.svx', { title: 'First island' }),
			page('regions/unified', 'content/docs/01-regions/00-unified/+doc.svx', { title: 'Unified regions', related: ['regions/held'] }, [{ depth: 2, id: 'why', text: 'Why' }]),
			page('regions/held', 'content/docs/01-regions/01-held/+doc.svx', { title: 'Held regions' }),
			page('data-state/stores', 'content/docs/02-data-state/00-stores/+doc.svx', { title: 'Stores' })
		]),
		schema: docSchema,
		relations: (self) => ({ related: self })
	});
}

/** A source-bearing fixture (entries carry raw markdown) for the search projection + engine. */
function searchable() {
	return content({
		loader: fromArray([
			{ id: 'start/install', filePath: 'content/docs/00-start/00-install/+doc.svx', data: { title: 'Install' }, meta: { headings: [{ depth: 2, id: 'setup', text: 'Setup' }] }, source: async () => '# Install\n\nGet started fast.\n\n## Setup\n\nRun the installer with npm.' },
			{ id: 'regions/held', filePath: 'content/docs/01-regions/00-held/+doc.svx', data: { title: 'Held regions' }, meta: { headings: [] }, source: async () => '# Held\n\nServer chosen islands.' }
		]),
		schema: docSchema
	});
}

const groups = (tree: NavTree) => tree.filter((n): n is NavGroup => n.kind === 'group');
const leaves = (g: NavGroup) => g.items.filter((n): n is NavLeaf => n.kind === 'leaf');

describe('outline — convention (bare collection)', () => {
	it('groups by section, orders by NN-, titles from data', async () => {
		const tree = await mint_site(docsFixture()).nav();
		const gs = groups(tree);
		expect(gs.map((g) => g.label)).toEqual(['Start', 'Regions', 'Data State']);
		expect(leaves(gs[0]).map((l) => l.title)).toEqual(['Install', 'First island']);
		expect(leaves(gs[0]).map((l) => l.slug)).toEqual(['start/install', 'start/first-island']);
	});

	it('applies the mount base to hrefs, slugs stay bare', async () => {
		const tree = await mint_site(docsFixture()).nav({ base: '/docs' });
		const first = leaves(groups(tree)[0])[0];
		expect(first.slug).toBe('start/install');
		expect(first.href).toBe('/docs/start/install');
	});
});

describe('address seams — group slug + trail scope', () => {
	// Two topics, each a group with its own collection; ids are `topic/page`.
	const svelteDocs = () =>
		content({
			loader: fromArray([
				page('runes/state', 'svelte/00-runes/00-state/+doc.svx', { title: 'State' }),
				page('runes/derived', 'svelte/00-runes/01-derived/+doc.svx', { title: 'Derived' })
			]),
			schema: docSchema
		});
	const kitDocs = () =>
		content({
			loader: fromArray([page('routing/pages', 'kit/00-routing/00-pages/+doc.svx', { title: 'Pages' })]),
			schema: docSchema
		});

	it('group `slug` drops a segment from the ADDRESS while nav/id keep structure', async () => {
		const site = mint_site([
			{ label: 'Svelte', items: svelteDocs(), base: 'docs/svelte', slug: (id) => id.split('/').pop()! }
		]);
		// Addresses (prerender slugs) use the dropped-segment policy…
		const addresses = (await site.entries()).map((e) => e.slug).sort();
		expect(addresses).toEqual(['docs/svelte/derived', 'docs/svelte/state']);
		// …and resolve by the shortened address works.
		expect(await site.doc('docs/svelte/state')).not.toBeNull();
		// …while nav STRUCTURE is unchanged: the `runes` section grouping is still there (id-derived).
		const tree = await site.nav();
		const svelte = groups(tree)[0] as NavGroup;
		expect(svelte.items.some((n) => n.kind === 'group' && n.label === 'Runes')).toBe(true);
	});

	it("trail: 'group' stops prev/next at the section boundary; 'weave' crosses it", async () => {
		const spec = () => [
			{ label: 'Svelte', items: svelteDocs(), base: 'svelte' },
			{ label: 'Kit', items: kitDocs(), base: 'kit' }
		];
		// last Svelte page: weave → next is the first Kit page; group → no next.
		const woven = await mint_site(spec(), { trail: 'weave' }).doc('svelte/runes/derived');
		expect(woven?.trail.next?.slug).toBe('kit/routing/pages');
		const grouped = await mint_site(spec(), { trail: 'group' }).doc('svelte/runes/derived');
		expect(grouped?.trail.next).toBeUndefined();
		// within a section, group still links
		const inner = await mint_site(spec(), { trail: 'group' }).doc('svelte/runes/state');
		expect(inner?.trail.next?.slug).toBe('svelte/runes/derived');
	});
});

describe('outline — group label from the source groups() facet', () => {
	it('overrides a section label via groups() (folder()/CMS supply it as data)', async () => {
		// The decoration is deliberately tiny: just `label`. Ordering belongs to `entry.order`, and
		// chrome behavior (collapsing, badges) to the explicit spec — never smuggled through decoration.
		const docs = content({
			loader: fromArray(
				[
					page('start/install', 'content/docs/00-start/00-install/+doc.svx', { title: 'Install' }),
					page('data-state/stores', 'content/docs/02-data-state/00-stores/+doc.svx', { title: 'Stores' })
				],
				new Map([['data-state', { label: 'Data & state' }]])
			),
			schema: docSchema
		});
		const tree = await mint_site(docs).nav();
		const ds = groups(tree).find((g) => g.items.some((i) => i.kind === 'leaf' && i.slug.startsWith('data-state')));
		expect(ds?.label).toBe('Data & state');
	});
});

describe('site — brains', () => {
	it('entries() yields every leaf slug in reading order', async () => {
		const site = mint_site(docsFixture());
		expect((await site.entries()).map((e) => e.slug)).toEqual(['start/install', 'start/first-island', 'regions/unified', 'regions/held', 'data-state/stores']);
	});

	it('doc() returns section, headings, and order-based trail', async () => {
		const site = mint_site(docsFixture());
		const view = await site.doc('start/install', { base: '/docs' });
		expect(view?.section).toBe('Start');
		expect(view?.href).toBe('/docs/start/install');
		expect(view?.trail.next?.slug).toBe('start/first-island');
		expect(view?.trail.next?.href).toBe('/docs/start/first-island');
		expect(view?.trail.prev).toBeUndefined();
	});

	it('doc() headings ride through from meta', async () => {
		const view = await mint_site(docsFixture()).doc('regions/unified');
		expect(view?.headings).toEqual([{ depth: 2, id: 'why', text: 'Why' }]);
	});

	it('prevNext "graph" prefers related, falls back to order', async () => {
		const site = mint_site(docsFixture(), { prevNext: 'graph' });
		const withRel = await site.doc('regions/unified');
		expect(withRel?.trail.suggested.map((r) => r.slug)).toEqual(['regions/held']); // from `related`
		const noRel = await site.doc('start/install');
		expect(noRel?.trail.suggested.map((r) => r.slug)).toEqual(['start/first-island']); // order fallback
	});

	it('doc() returns null for an unknown slug', async () => {
		expect(await mint_site(docsFixture()).doc('nope/missing')).toBeNull();
	});
});

describe('outline — multi-collection weave', () => {
	function apiFixture() {
		return content({
			loader: fromArray([page('button', 'api/00-button.json', { title: 'Button' }), page('input', 'api/01-input.json', { title: 'Input' })]),
			schema: v.object({ title: v.string() })
		});
	}

	it('weaves two collections with a base prefix and a link', async () => {
		const docs = docsFixture();
		const api = apiFixture();
		const site = mint_site(
			outline([
				{ label: 'Guides', items: docs },
				{ label: 'API', items: api, base: 'api', collapsed: true },
				{ label: 'GitHub', href: 'https://example.com' }
			])
		);
		const tree = await site.nav({ base: '/d' });
		const labels = tree.map((n) => (n.kind === 'group' ? n.label : n.kind === 'link' ? `link:${n.label}` : n.slug));
		expect(labels).toEqual(['Guides', 'API', 'link:GitHub']);

		const apiGroup = tree.find((n): n is NavGroup => n.kind === 'group' && n.label === 'API')!;
		const apiLeaf = leaves(apiGroup)[0];
		expect(apiLeaf.slug).toBe('api/button');
		expect(apiLeaf.href).toBe('/d/api/button');

		// address resolves across collections
		expect(await site.doc('api/input').then((v) => v?.entry.data.title)).toBe('Input');
	});

	it('pick() places explicit ids in order; a bare remainder mops up the rest', async () => {
		const docs = docsFixture();
		const site = mint_site(
			outline([
				{ label: 'Highlights', items: pick(docs, 'regions/held', 'start/install') }, // explicit order
				docs // remainder
			])
		);
		const tree = await site.nav();
		const hi = tree.find((n): n is NavGroup => n.kind === 'group' && n.label === 'Highlights')!;
		expect(leaves(hi).map((l) => l.slug)).toEqual(['regions/held', 'start/install']);
		// remainder no longer includes the two picked pages
		const addresses = await site.entries();
		expect(addresses.filter((a) => a.slug === 'start/install')).toHaveLength(1); // placed once
	});

	it('glob pick expands in convention order', async () => {
		const docs = docsFixture();
		const site = mint_site(outline([{ label: 'Regions', items: pick(docs, 'regions/**') }, docs]));
		const tree = await site.nav();
		const rg = tree.find((n): n is NavGroup => n.kind === 'group' && n.label === 'Regions')!;
		expect(leaves(rg).map((l) => l.slug)).toEqual(['regions/unified', 'regions/held']);
	});
});

describe('outline — build-time safety', () => {
	it('errors on orphan entries (fully manual, leftover)', async () => {
		const docs = docsFixture();
		const site = mint_site(outline([{ label: 'Only start', items: pick(docs, 'start/install') }]));
		await expect(site.nav()).rejects.toThrow(/unplaced entr/);
	});

	it('errors on an unknown pick id', async () => {
		const docs = docsFixture();
		const site = mint_site(outline([{ label: 'X', items: pick(docs, 'does/not-exist') }, docs]));
		await expect(site.nav()).rejects.toThrow(/not found/);
	});

	it('errors on a slug collision across collections', async () => {
		const a = content({ loader: fromArray([page('dup', 'a/dup.json', { title: 'A' })]), schema: v.object({ title: v.string() }) });
		const b = content({ loader: fromArray([page('dup', 'b/dup.json', { title: 'B' })]), schema: v.object({ title: v.string() }) });
		const site = mint_site(outline([a, b])); // both mint slug 'dup'
		await expect(site.nav()).rejects.toThrow(/slug collision/);
	});
});

describe('emissions', () => {
	const event = (path: string) => ({ url: new URL(`https://ogygia.dev${path}`) });

	it('sitemap lists every leaf as an absolute URL', async () => {
		const site = mint_site(docsFixture());
		const res = await site.emit.sitemap({ base: '/docs' })(event('/sitemap.xml'));
		const xml = await res.text();
		expect(res.headers.get('content-type')).toBe('application/xml');
		expect(xml).toContain('<loc>https://ogygia.dev/docs/start/install</loc>');
		expect(xml).toContain('<loc>https://ogygia.dev/docs/data-state/stores</loc>');
		expect((xml.match(/<loc>/g) ?? []).length).toBe(5); // every leaf, once
	});

	it('sitemap honors an explicit origin (for prerendered output)', async () => {
		const site = mint_site(docsFixture());
		const xml = await site.emit.sitemap({ base: '/docs', origin: 'https://prod.example' })(event('/sitemap.xml')).then((r) => r.text());
		expect(xml).toContain('<loc>https://prod.example/docs/start/install</loc>');
	});

	it('llms.txt is an llmstxt.org index grouped by section', async () => {
		const site = mint_site(docsFixture());
		const txt = await site.emit.llms({ base: '/docs', title: 'Ogygia', description: 'SSR islands.' })(event('/llms.txt')).then((r) => r.text());
		expect(txt.startsWith('# Ogygia\n')).toBe(true);
		expect(txt).toContain('> SSR islands.');
		expect(txt).toContain('## Start');
		expect(txt).toContain('- [Install](https://ogygia.dev/docs/start/install)');
		expect(txt).toContain('## Data State'); // no meta collection in this fixture → title-cased
	});

	it('llms.txt renders top-level links under Pages and titles+summaries', async () => {
		const api = content({ loader: fromArray([page('button', 'api/00-button.json', { title: 'Button' })]), schema: v.object({ title: v.string() }) });
		const site = mint_site(outline([{ label: 'API', items: api }, { label: 'GitHub', href: 'https://example.com' }]));
		const txt = await site.emit.llms({})(event('/llms.txt')).then((r) => r.text());
		expect(txt).toContain('## Pages');
		expect(txt).toContain('- [GitHub](https://example.com)');
		expect(txt).toContain('## API');
	});
});

describe('emissions — raw markdown (from entry.source)', () => {
	// A collection whose entries carry their own lazy `source` — exactly what the markdown compiler
	// injects. One entry has no source (a data-only page); it must not be emitted or prerendered.
	const sourced = () =>
		content({
			loader: fromArray([
				{ id: 'start/install', filePath: 'content/docs/00-start/00-install/+doc.svx', data: { title: 'Install' }, meta: { headings: [] }, source: async () => '---\ntitle: Install\n---\n\n# Install\n\nRun the installer.' },
				{ id: 'data-state/stores', filePath: 'content/docs/02-data-state/00-stores/+doc.svx', data: { title: 'Stores' }, meta: { headings: [] } } // no source
			]),
			schema: docSchema
		});

	it('serves entry.source(), frontmatter stripped by default', async () => {
		const emit = mint_site(sourced()).emit.raw();
		const res = await emit.GET({ params: { slug: 'start/install' } });
		expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(await res.text()).toBe('# Install\n\nRun the installer.');
	});

	it('keeps frontmatter when asked', async () => {
		const emit = mint_site(sourced()).emit.raw({ frontmatter: 'keep' });
		expect(await emit.GET({ params: { slug: 'start/install' } }).then((r) => r.text())).toMatch(/^---\ntitle: Install/);
	});

	it('entries() lists only slugs whose entry has source; unknown or source-less → 404', async () => {
		const emit = mint_site(sourced()).emit.raw();
		expect((await emit.entries()).map((e) => e.slug)).toEqual(['start/install']);
		expect((await emit.GET({ params: { slug: 'data-state/stores' } })).status).toBe(404); // no source
		expect((await emit.GET({ params: { slug: 'nope' } })).status).toBe(404);
	});
});

describe('redirect history (redirect_from)', () => {
	const redirected_docs = () =>
		content({
			loader: fromArray([
				page('start/install', 'content/docs/00-start/00-install/+doc.svx', { title: 'Install', redirect_from: ['start/setup', 'installation'] }),
				page('regions/held', 'content/docs/01-regions/00-held/+doc.svx', { title: 'Held' })
			]),
			schema: v.object({ title: v.string(), redirect_from: v.optional(v.array(v.string()), []) })
		});

	it('aliases resolve to their canonical slug; entries() includes them', async () => {
		const site = mint_site(redirected_docs());
		expect(await site.outline.alias('start/setup')).toBe('start/install');
		expect(await site.outline.alias('installation')).toBe('start/install');
		const slugs = (await site.entries()).map((e) => e.slug);
		expect(slugs).toContain('start/install');
		expect(slugs).toContain('start/setup'); // alias prerenders → baked redirect
	});

	it('load 308s an alias to the canonical URL (base by subtraction)', async () => {
		const site = mint_site(redirected_docs());
		const event = { params: { slug: 'start/setup' }, url: new URL('https://x.dev/docs/start/setup') };
		const thrown = await site.load(event).then(
			() => null,
			(e: unknown) => e as { status?: number; location?: string }
		);
		expect(thrown?.status).toBe(308);
		expect(thrown?.location).toBe('/docs/start/install');
	});

	it('an alias shadowing a live page is a build error', async () => {
		const bad = content({
			loader: fromArray([
				page('a', 'x/00-a/+doc.svx', { title: 'A', redirect_from: ['b'] }),
				page('b', 'x/01-b/+doc.svx', { title: 'B' })
			]),
			schema: v.object({ title: v.string(), redirect_from: v.optional(v.array(v.string()), []) })
		});
		await expect(mint_site(bad).nav()).rejects.toThrow(/shadows a live page/);
	});

	it('two entries claiming one old address is a build error', async () => {
		const bad = content({
			loader: fromArray([
				page('a', 'x/00-a/+doc.svx', { title: 'A', redirect_from: ['old'] }),
				page('b', 'x/01-b/+doc.svx', { title: 'B', redirect_from: ['old'] })
			]),
			schema: v.object({ title: v.string(), redirect_from: v.optional(v.array(v.string()), []) })
		});
		await expect(mint_site(bad).nav()).rejects.toThrow(/claimed by both/);
	});
});

describe('link audit', () => {
	type L = { href: string; text: string; line?: number };
	const linked = (links_by_id: Record<string, L[]>, extra?: { redirect_from?: string[] }) =>
		content({
			loader: fromArray([
				page('start/install', 'content/docs/00-start/00-install/+doc.svx', { title: 'Install', ...(extra ?? {}) }, [{ depth: 2, id: 'setup', text: 'Setup' }]),
				{ id: 'guide', filePath: 'content/docs/01-x/01-guide/+doc.svx', data: { title: 'Guide' }, meta: { headings: [], links: links_by_id['guide'] ?? [] } as unknown as Meta }
			]),
			schema: v.object({ title: v.string(), redirect_from: v.optional(v.array(v.string()), []) })
		});

	it('links() check flags a missing page and a missing anchor; skips external + out-of-mount', async () => {
		const site = mint_site(
			linked({
				guide: [
					{ href: '/docs/start/install', text: 'ok' },
					{ href: '/docs/start/install#setup', text: 'ok anchor' },
					{ href: '/docs/start/install#nope', text: 'bad anchor', line: 12 },
					{ href: '/docs/gone/page', text: 'dead', line: 3 },
					{ href: 'https://example.com/x', text: 'external' },
					{ href: '/demo/other', text: 'outside mount' }
				]
			}),
			{ checks: [links()] }
		);
		const findings = await site.check({ base: '/docs' });
		expect(findings.map((f) => ({ slug: f.slug, severity: f.severity, message: f.message }))).toEqual([
			{ slug: 'guide', severity: 'error', message: `'/docs/start/install#nope': missing anchor #nope — link text "bad anchor"` },
			{ slug: 'guide', severity: 'error', message: `'/docs/gone/page': missing page — link text "dead"` }
		]);
	});

	it('a link through redirect history is a warn (stale), not an error', async () => {
		const site = mint_site(linked({ guide: [{ href: '/docs/start/old-name', text: 'stale' }] }, { redirect_from: ['start/old-name'] }), { checks: [links()] });
		const findings = await site.check({ base: '/docs' });
		expect(findings.map((f) => ({ severity: f.severity, message: f.message }))).toEqual([
			{ severity: 'warn', message: `'/docs/start/old-name' works via redirect_from → update to /docs/start/install` }
		]);
	});

	it('checks in load throw on an error finding (build/dev failure)', async () => {
		const site = mint_site(linked({ guide: [{ href: '/docs/gone', text: 'dead' }] }), { checks: [links()] });
		const event = { params: { slug: 'guide' }, url: new URL('https://x.dev/docs/guide') };
		await expect(site.load(event)).rejects.toThrow(/check failure.*'guide'/s);
	});

	it('checks in load pass a clean page; self-anchor resolves against own headings', async () => {
		const clean = content({
			loader: fromArray([
				{ id: 'solo', filePath: 'content/docs/00-a/00-solo/+doc.svx', data: { title: 'Solo' }, meta: { headings: [{ depth: 2, id: 'here', text: 'Here' }], links: [{ href: '#here', text: 'self' }] } as unknown as Meta }
			]),
			schema: v.object({ title: v.string() })
		});
		const site = mint_site(clean, { checks: [links()] });
		await expect(site.load({ params: { slug: 'solo' }, url: new URL('https://x.dev/docs/solo') })).resolves.toBeUndefined();
	});
});

describe('search — projection', () => {
	it('strip_prose removes frontmatter, code, tags, markdown syntax', () => {
		const src = '---\ntitle: X\n---\n\n<script>let a=1;</script>\n\n# Heading\n\nSome **bold** and `code` and [a link](/x).\n\n```ts\nconst y = 2;\n```\n';
		expect(strip_prose(src)).toBe('Heading Some bold and code and a link.');
	});

	it('split_sections chunks by heading, aligned to collected headings', () => {
		const source = '# Install\n\nLead text.\n\n## Setup\n\nRun the installer.\n\n## Usage\n\nUse it well.';
		const headings = [
			{ depth: 2 as const, id: 'setup', text: 'Setup' },
			{ depth: 2 as const, id: 'usage', text: 'Usage' }
		];
		const chunks = split_sections(source, headings);
		expect(chunks.map((c) => c.heading?.id ?? null)).toEqual([null, 'setup', 'usage']);
		expect(chunks[1].text).toContain('Run the installer');
	});

	it('build_docs makes one document per section, with slug + anchor', async () => {
		const site = mint_site(searchable());
		const docs = await build_docs(site.outline);
		const install = docs.filter((d) => d.slug === 'start/install');
		expect(install.map((d) => d.anchor)).toEqual(['', 'setup']); // lead + one heading chunk
		expect(install.find((d) => d.anchor === 'setup')?.id).toBe('start/install#setup');
		expect(docs.find((d) => d.slug === 'regions/held')?.heading).toBe('');
	});
});

describe('search — engine + brain (Orama)', () => {
	it('orama_engine indexes docs and ranks a term match', async () => {
		const engine = orama_engine();
		await engine.init?.();
		const index = await engine.build([
			{ id: 'a', slug: 'a', anchor: '', title: 'Install', section: 'Start', heading: '', text: 'run the installer with npm' },
			{ id: 'b', slug: 'b', anchor: '', title: 'Regions', section: 'Core', heading: '', text: 'server chosen islands' }
		]);
		const hits = await index.query('installer', { limit: 5, base: '/docs' });
		expect(hits[0].slug).toBe('a');
		expect(hits[0].href).toBe('/docs/a');
	});

	it('site.search() returns ranked hits with mount-based hrefs; scoping pre-filters', async () => {
		const site = mint_site(searchable());
		const hits = await site.search('installer', { base: '/docs' });
		expect(hits[0].slug).toBe('start/install');
		expect(hits[0].href).toBe('/docs/start/install#setup'); // the section that holds "installer"

		// Weave a second collection lacking the term; scoping to it yields nothing (pre-filter).
		const guides = searchable();
		const other = content({ loader: fromArray([{ id: 'z', filePath: 'other/00-z/+doc.svx', data: { title: 'Z' }, meta: { headings: [] }, source: async () => '# Z\n\nnothing here' }]), schema: docSchema });
		const scoped = mint_site(outline([{ label: 'Guides', items: guides, base: 'g' }, { label: 'Other', items: other, base: 'o' }]));
		expect((await scoped.search('installer', { in: [other] })).length).toBe(0);
		expect((await scoped.search('installer', { in: [guides] })).length).toBeGreaterThan(0);
	});

	it('site.emit.search() serializes the section documents', async () => {
		const site = mint_site(searchable());
		const res = await site.emit.search()({ url: new URL('https://x.dev/search.json') });
		const docs = (await res.json()) as Array<{ slug: string }>;
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(docs.some((d) => d.slug === 'start/install')).toBe(true);
	});
});

describe('mountBase', () => {
	it('subtracts the slug from the pathname', () => {
		expect(mountBase({ pathname: '/docs/start/install' }, 'start/install')).toBe('/docs');
		expect(mountBase({ pathname: '/start/install' }, 'start/install')).toBe('');
		expect(mountBase({ pathname: '/docs' }, '')).toBe('/docs');
	});
});

describe('rehypeOverrides (element → slot rewrite)', () => {
	it('rewrites configured tags to the slot with a `tag` prop; leaves others alone', () => {
		const tree = {
			type: 'root',
			children: [
				{ type: 'element', tagName: 'a', properties: { href: '/x' }, children: [{ type: 'text', value: 'link' }] },
				{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'img', properties: { src: '/i.png' }, children: [] }] }
			]
		};
		rehypeOverrides(['a', 'img'])(tree);
		const a = tree.children[0] as { tagName: string; properties: Record<string, unknown> };
		const img = (tree.children[1] as { children: { tagName: string; properties: Record<string, unknown> }[] }).children[0];
		expect(a.tagName).toBe(SLOT_TAG);
		expect(a.properties).toEqual({ href: '/x', tag: 'a' });
		expect(img.tagName).toBe(SLOT_TAG);
		expect(img.properties).toEqual({ src: '/i.png', tag: 'img' });
		expect((tree.children[1] as { tagName: string }).tagName).toBe('p'); // untouched
	});
});

describe('remarkLinks collector', () => {
	it('collects every markdown link with text and line into fm.links', () => {
		const tree = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					children: [
						{ type: 'link', url: '/docs/a', position: { start: { line: 4 } }, children: [{ type: 'text', value: 'A page' }] },
						{ type: 'link', url: 'https://x.dev', children: [{ type: 'inlineCode', value: 'code' }] }
					]
				}
			]
		};
		const file = { data: {} as Record<string, unknown> };
		remarkLinks()(tree, file);
		expect((file.data.fm as { links: unknown }).links).toEqual([
			{ href: '/docs/a', text: 'A page', line: 4 },
			{ href: 'https://x.dev', text: 'code' }
		]);
	});
});

describe('build_rss', () => {
	it('emits sorted RSS 2.0 with absolutized links', async () => {
		const { build_rss } = await import('../src/content/site/emit.js');
		const xml = build_rss('https://example.dev', {
			title: 'Feed <T>',
			description: 'desc',
			base: '/blog',
			items: [
				{ href: '/blog/old', title: 'Old', date: '2020-01-01' },
				{ href: '/blog/new', title: 'New & shiny', description: 'd', date: '2026-08-13' }
			]
		});
		expect(xml).toContain('<title>Feed &lt;T&gt;</title>');
		expect(xml).toContain('<link>https://example.dev/blog</link>');
		expect(xml.indexOf('New &amp; shiny')).toBeLessThan(xml.indexOf('>Old<'));
		expect(xml).toContain('<guid isPermaLink="true">https://example.dev/blog/new</guid>');
		expect(xml).toContain('<pubDate>Thu, 13 Aug 2026 00:00:00 GMT</pubDate>');
	});
});
