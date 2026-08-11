import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { content, glob, markdown, json } from '../src/content/index.js';
import type { Source, SourceEntry } from '../src/content/index.js';
import { parseFrontmatter } from '../src/content/markdown/frontmatter.js';
import { withRemotes } from '../src/content/server.js';
import { content as contentPlugin, invalidateModuleTree } from '../src/content/vite/plugin.js';
import type { ModuleNode, ViteDevServer } from 'vite';

const REGION_BRAND = Symbol.for('ogygia.region');

const blogSchema = v.object({
	title: v.string(),
	date: v.pipe(
		v.union([v.string(), v.date()]),
		v.transform((x) => (x instanceof Date ? x : new Date(x)))
	),
	draft: v.optional(v.boolean(), false)
});

/** A tiny `.svx`-module fixture as the markdown source sees it (compiled by the markdown pipeline). */
const svx = (metadata: Record<string, unknown>, component: unknown = {}) => ({
	metadata,
	default: component
});

/** In-memory source for fixtures. The lib no longer ships `fromArray` (write a `{get,list,ids}`
 *  directly), so tests keep this local copy for building fixtures with explicit ids. */
function fromArray<Meta = Record<string, never>>(entries: SourceEntry<Meta>[]): Source<Meta> {
	const map = new Map(entries.map((e) => [e.id, e]));
	return {
		async get(id) {
			return map.get(id) ?? null;
		},
		async list() {
			return entries.slice();
		},
		async ids() {
			return entries.map((e) => e.id);
		}
	};
}

describe('frontmatter', () => {
	it('parses yaml and strips body', () => {
		const { data: fm, body } = parseFrontmatter(`---
title: Hello
draft: true
---

# Hi
`);
		expect(fm.title).toBe('Hello');
		expect(fm.draft).toBe(true);
		expect(body.trim()).toBe('# Hi');
	});

	it('rejects broken yaml', () => {
		expect(() => parseFrontmatter(`---\n: : :\n---\n`)).toThrow(/invalid frontmatter/);
	});
});

describe('glob() source ids', () => {
	it('strips shared prefix + extension generically (no hardcoded format list)', async () => {
		const src = glob({
			'./content/blog/nested/deep-post.svx': {},
			'./content/blog/top.svx': {}
		});
		expect((await src.ids()).sort()).toEqual(['nested/deep-post', 'top']);
	});

	it('honors a custom id mapper', async () => {
		const src = glob(
			{ './pages/00-intro.json': {} },
			{ id: (k) => k.replace(/.*\//, '').replace(/^\d+-/, '').replace(/\.json$/, '') }
		);
		expect(await src.ids()).toEqual(['intro']);
	});
});

describe('format source-builders', () => {
	it('markdown: data + inline-partial body + headings in meta', async () => {
		const Comp = { __c: true };
		const src = markdown({
			'./x.svx': svx({ title: 'Hi', headings: [{ depth: 2, id: 'intro', text: 'Intro' }] }, Comp)
		});
		const [e] = await src.list();
		expect(e.data.title).toBe('Hi');
		expect('headings' in e.data).toBe(false);
		expect(e.meta.headings).toEqual([{ depth: 2, id: 'intro', text: 'Intro' }]);
		expect(e.body).toMatchObject({ kind: 'inline', component: Comp, props: {} });
		expect((e.body as Record<symbol, unknown>)[REGION_BRAND]).toBe(true);
	});

	it('json: unwraps default, data-only (no body)', async () => {
		const src = json({ './a.json': { default: { name: 'Ada' } }, './b.json': { name: 'Bob' } });
		const byId = new Map((await src.list()).map((e) => [e.id, e]));
		expect(byId.get('a')?.data.name).toBe('Ada');
		expect(byId.get('b')?.data.name).toBe('Bob');
		expect(byId.get('a')?.body).toBeUndefined();
	});

	// NB: no `yaml()` / `raw()` content sources are shipped — ogygia's YAML parser is
	// frontmatter-only; a `.yaml` or raw-string loader is a short docs recipe.
});

describe('content() catalog', () => {
	it('rejects a bare glob map (from must be a source)', () => {
		expect(() =>
			content({
				// @ts-expect-error a glob map is not a source — wrap it in markdown()/json()/glob()
				loader: { './blog/hello.svx': svx({ title: 'Hi', date: '2026-01-01' }) },
				schema: blogSchema
			})
		).toThrow(/must be a source/);
	});

	it('entries / entry from markdown(glob)', async () => {
		const blog = content({
			loader: markdown({ './blog/hello.svx': svx({ title: 'Hi', date: '2026-01-01' }) }),
			schema: blogSchema
		});
		expect(await blog.ids()).toEqual(['hello']);
		expect((await blog.entry('hello'))?.data.title).toBe('Hi');
	});

	it('get() returns id/data/meta + inline-partial body', async () => {
		const Comp = { __c: true };
		const blog = content({
			loader: markdown({
				'./blog/hello.svx': svx(
					{ title: 'Hi', date: '2026-01-01', headings: [{ depth: 2, id: 'intro', text: 'Intro' }] },
					Comp
				)
			}),
			schema: blogSchema
		});
		const out = (await blog.get('hello'))!;
		expect(out.id).toBe('hello');
		expect(out.data.title).toBe('Hi');
		expect(out.meta.headings).toEqual([{ depth: 2, id: 'intro', text: 'Intro' }]);
		expect(out.body).toMatchObject({ kind: 'inline', component: Comp, props: {} });
	});

	it('get() returns null on a filtered-out / unknown id', async () => {
		const blog = content({
			loader: markdown({ './blog/draft.svx': svx({ title: 'D', date: '2026-01-01', draft: true }) }),
			schema: blogSchema,
			filter: (e) => !e.data.draft
		});
		expect(await blog.get('draft')).toBeNull();
		expect(await blog.get('nonexistent')).toBeNull();
	});

	it('get() on a data-only entry has no body', async () => {
		const cms = content({
			schema: v.object({ title: v.string() }),
			loader: json({ './a.json': { title: 'A' } })
		});
		const out = (await cms.get('a'))!;
		expect(out.body).toBeUndefined();
		expect(out.data.title).toBe('A');
		expect(out.meta).toEqual({});
	});

	it('list mints a prerender remote (static source)', async () => {
		const blog = content({
			loader: markdown({
				'./blog/hello.svx': svx({ title: 'Hi', date: '2026-01-01', draft: false }),
				'./blog/draft.svx': svx({ title: 'Nope', date: '2026-01-01', draft: true })
			}),
			schema: blogSchema
		});
		const list = withRemotes(blog).list({
			filter: (e) => !e.data.draft,
			map: (e) => ({ id: e.id, title: e.data.title })
		});
		expect((list as { __: { type: string } }).__.type).toBe('prerender');
		expect(await list()).toEqual([{ id: 'hello', title: 'Hi' }]);
	});

	it('collection-level filter hides entries from every read path', async () => {
		const blog = content({
			loader: markdown({
				'./blog/live.svx': svx({ title: 'Live', date: '2026-01-01', draft: false }),
				'./blog/draft.svx': svx({ title: 'Draft', date: '2026-01-01', draft: true })
			}),
			schema: blogSchema,
			filter: (e) => !e.data.draft
		});

		expect(await blog.ids()).toEqual(['live']);
		expect((await blog.entries()).map((e) => e.id)).toEqual(['live']);
		expect(await blog.entry('draft')).toBeNull();

		const list = withRemotes(blog).list();
		expect(await list()).toEqual([{ id: 'live', data: expect.objectContaining({ title: 'Live' }) }]);

		expect((await blog.get('live'))!.data.title).toBe('Live');
		expect(await blog.get('draft')).toBeNull();
	});

	it('per-remote filter narrows the collection filter (AND), never widens it', async () => {
		const blog = content({
			loader: markdown({
				'./blog/a.svx': svx({ title: 'A', date: '2026-01-01', draft: false }),
				'./blog/b.svx': svx({ title: 'B', date: '2026-01-01', draft: false }),
				'./blog/d.svx': svx({ title: 'D', date: '2026-01-01', draft: true })
			}),
			schema: blogSchema,
			filter: (e) => !e.data.draft
		});
		const list = withRemotes(blog).list({
			filter: (e) => e.data.draft || e.data.title === 'A',
			map: (e) => e.id
		});
		expect(await list()).toEqual(['a']);
	});
});

/** A live source: `list()` returns accumulated rows, `live()` yields whenever a new row is pushed. */
function liveSource() {
	const rows: SourceEntry[] = [];
	const waiters: Array<() => void> = [];
	const source: Source = {
		async get(id) {
			return rows.find((r) => r.id === id) ?? null;
		},
		async list() {
			return rows.slice();
		},
		async ids() {
			return rows.map((r) => r.id);
		},
		async *live() {
			while (true) {
				await new Promise<void>((r) => waiters.push(r));
				yield 1;
			}
		}
	};
	return {
		source,
		push(e: SourceEntry) {
			rows.push(e);
			waiters.splice(0).forEach((w) => w());
		}
	};
}

describe('live source + live remotes', () => {
	it('live.list mints query_live and projects the seeded snapshot', async () => {
		const { source, push } = liveSource();
		push({ id: 'a', data: { title: 'A' } });
		const remote = withRemotes(content({ schema: v.object({ title: v.string() }), loader: source })).live.list({
			map: (e) => ({ id: e.id, title: e.data.title })
		});
		expect((remote as { __: { type: string } }).__.type).toBe('query_live');
		const gen = (await remote()) as AsyncGenerator<Array<{ id: string; title: string }>>;
		expect((await gen.next()).value).toEqual([{ id: 'a', title: 'A' }]);
		await gen.return?.(undefined);
	});

	it('live.get projects one id from the seeded snapshot', async () => {
		const { source, push } = liveSource();
		push({ id: 'a', data: { title: 'one' } });
		const remote = withRemotes(content({ schema: v.object({ title: v.string() }), loader: source })).live.get({
			map: (e) => ({ title: e.data.title })
		});
		const gen = (await remote('a')) as AsyncGenerator<{ title: string } | null>;
		expect((await gen.next()).value).toEqual({ title: 'one' });
		await gen.return?.(undefined);
	});
});

describe('content graph — relations + backlinks', () => {
	const people = content({
		schema: v.object({ name: v.string() }),
		loader: fromArray([
			{ id: 'ada', data: { name: 'Ada' } },
			{ id: 'grace', data: { name: 'Grace' } }
		])
	});

	const docs = content({
		schema: v.object({
			title: v.string(),
			author: v.optional(v.string()),
			related: v.optional(v.array(v.string()), [])
		}),
		loader: fromArray([
			{ id: 'intro', data: { title: 'Intro', author: 'ada', related: ['setup'] } },
			{ id: 'setup', data: { title: 'Setup', author: 'grace', related: [] } },
			{ id: 'deep', data: { title: 'Deep', author: 'ada', related: ['intro', 'setup'] } }
		]),
		relations: (self) => ({ author: people, related: self })
	});

	it('resolves a single-string relation to one RefEntry', async () => {
		const e = (await docs.get('intro'))!;
		expect(e.rel?.author).toEqual({ id: 'ada', data: { name: 'Ada' } });
	});

	it('resolves an array relation to RefEntry[]', async () => {
		const e = (await docs.get('deep'))!;
		expect((e.rel?.related as { id: string }[]).map((r) => r.id)).toEqual(['intro', 'setup']);
	});

	it('a missing single ref is null', async () => {
		const orphan = content({
			schema: v.object({ title: v.string(), author: v.optional(v.string()) }),
			loader: fromArray([{ id: 'x', data: { title: 'X', author: 'nobody' } }]),
			relations: () => ({ author: people })
		});
		expect((await orphan.get('x'))!.rel?.author).toBeNull();
	});

	it('inverts backlinks across collections', async () => {
		const ada = (await people.get('ada'))!;
		expect(ada.backlinks?.map((b) => b.id).sort()).toEqual(['deep', 'intro']);
		const setup = (await docs.get('setup'))!;
		expect(setup.backlinks?.map((b) => b.id).sort()).toEqual(['deep', 'intro']);
	});

	it('a collection with no relations still receives backlinks from others', async () => {
		expect((await people.get('grace'))!.backlinks?.map((b) => b.id)).toEqual(['setup']);
	});
});

describe('vite content plugin', () => {
	it('exposes invalidateModuleTree', () => {
		const a = { id: 'a', importers: new Set() } as unknown as ModuleNode;
		const invalidated: string[] = [];
		const server = {
			moduleGraph: {
				invalidateModule(m: ModuleNode) {
					invalidated.push(m.id!);
				}
			}
		} as unknown as ViteDevServer;
		expect(invalidateModuleTree(server, a)).toBe(1);
		expect(invalidated).toEqual(['a']);
	});

	it('plugin has no content.config transform', () => {
		const plugin = contentPlugin();
		expect(plugin.transform).toBeUndefined();
	});

	it('handles importer cycles', () => {
		const a = { id: 'a', importers: new Set<ModuleNode>() } as unknown as ModuleNode;
		const b = { id: 'b', importers: new Set<ModuleNode>() } as unknown as ModuleNode;
		a.importers.add(b);
		b.importers.add(a);
		const server = {
			moduleGraph: { invalidateModule: vi.fn() }
		} as unknown as ViteDevServer;
		expect(invalidateModuleTree(server, a)).toBe(2);
	});
});
