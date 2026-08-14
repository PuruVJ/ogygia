/**
 * Search — the brain and its engine seam.
 *
 * The 80/20 shape: what ships here is the ENUMERABLE path — entries are projected into
 * section-granular documents (split by heading, so hits deep-link to `#anchors`), an engine adapter
 * builds an in-memory index lazily (single-flight, memoized, invalidated when a collection's
 * catalog version changes), and `site.search(q)` queries it. The same documents serialize to a
 * prerendered `search.json` (`site.emit.search`) that the client worker ingests.
 *
 * Deliberately NOT here (the user-pluggable 20%): CMS-native search delegation, hybrid merging,
 * per-shard weights. A remote backend plugs in as a plain `query` function on the `<Search>` brick.
 *
 * The default engine is **Orama** (optional peer, lazy-loaded). The adapter contract is tiny, so an
 * engine swap (MiniSearch, FlexSearch, custom) is a one-line `engine:` option.
 */
import type { Heading, LinkRef } from '../content/index.js';
import { href_of, type Collection, type Outline } from './outline.js';
import { is_dimensioned } from './dimensions.js';

/** One searchable document — a page SECTION (split by heading), or the page lead. Mount-independent:
 *  stores `slug` + `anchor`, so href is computed per query with the caller's `base`. */
export type SearchDoc = {
	/** Stable id: `slug` or `slug#anchor`. */
	id: string;
	slug: string;
	/** Heading id to deep-link to, or empty for the page lead. */
	anchor: string;
	/** Page title. */
	title: string;
	/** Top-level nav group ("Start", "Reference"). */
	section: string;
	/** The heading this chunk sits under; empty for the page lead. */
	heading: string;
	/** Plain prose of the chunk (markdown syntax lightly stripped). */
	text: string;
};

/** One ranked hit — plain data, ready to render as a link. */
export type SearchHit = {
	href: string;
	slug: string;
	title: string;
	section: string;
	heading: string;
	/** Short excerpt of the matched chunk. */
	excerpt: string;
	score: number;
};

/** The engine adapter: build documents into a queryable index. Must run in node AND the browser. */
export type SearchEngine = {
	/** Lazy-load the engine library (optional peer). Called once before the first build. */
	init?(): Promise<void>;
	build(docs: SearchDoc[]): Promise<SearchIndex>;
};
export type SearchIndex = {
	query(q: string, opts: { limit: number; base: string }): Promise<SearchHit[]>;
};

export type SearchOptions = {
	/** Cap results (default 10). */
	limit?: number;
	/** Pre-filter: only these collections' shards are consulted (by handle identity). */
	in?: Collection[];
	/** Mount prefix for the hit hrefs (default `''`). */
	base?: string;
};

// ── projection: entries → section documents ─────────────────────────────────

/** Light markdown/svx strip for index text: fences, tags, inline markers. Not a parser — good
 *  enough for tokenization. */
export function strip_prose(src: string): string {
	return src
		.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') // frontmatter
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/[*_~>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Split a page's source into `{ heading, text }` chunks aligned to its collected headings. */
export function split_sections(source: string, headings: Heading[]): { heading: Heading | null; text: string }[] {
	const body = source.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	const lines = body.split('\n');
	const chunks: { heading: Heading | null; text: string }[] = [];
	let current: { heading: Heading | null; lines: string[] } = { heading: null, lines: [] };
	let next_heading = 0;

	const heading_text = (line: string): string | null => {
		const m = line.match(/^#{2,4}\s+(.+?)\s*(\{#[^}]+\})?\s*$/);
		return m ? m[1].trim() : null;
	};

	for (const line of lines) {
		const ht = heading_text(line);
		if (ht !== null) {
			chunks.push({ heading: current.heading, text: current.lines.join('\n') });
			// Align to the collected headings in order; fall back to a text-only match.
			const collected = headings[next_heading];
			current = { heading: collected ?? null, lines: [] };
			next_heading += 1;
		} else {
			current.lines.push(line);
		}
	}
	chunks.push({ heading: current.heading, text: current.lines.join('\n') });
	return chunks
		.map((c) => ({ heading: c.heading, text: strip_prose(c.text) }))
		.filter((c) => c.text || c.heading);
}

/** Build every searchable document for the outline's leaves (optionally scoped to collections). */
export async function build_docs(ol: Outline, only?: Collection[]): Promise<SearchDoc[]> {
	const docs: SearchDoc[] = [];
	// A dimensioned site: index only the DEFAULT coordinate (canonical). Otherwise every fallback page
	// under /hi, /v1, … re-indexes the same content and search shows it as duplicate hits.
	const addrs = is_dimensioned(ol) ? await ol.canonicalAddresses() : await ol.addresses();
	for (const slug of addrs) {
		const hit = await ol.resolve(slug);
		if (!hit) continue;
		if (only && !only.includes(hit.collection)) continue;
		const entry = await hit.collection.get(hit.record.entryId);
		if (!entry) continue;
		const data = entry.data as { title?: string; summary?: string };
		const title = typeof data.title === 'string' ? data.title : slug;
		const headings = extract_headings(entry.meta);

		if (entry.source) {
			const chunks = split_sections(await entry.source(), headings);
			// Chunks are keyed by `slug#anchor` (bare slug for the heading-less intro). `split_sections`
			// can emit more than one heading-less chunk per page — MERGE their text into one doc rather
			// than pushing a duplicate id (Orama's `insert` throws on a repeated id, which would kill the
			// whole index build). Merging keeps the text searchable without duplicate hits.
			const by_key = new Map<string, SearchDoc>();
			for (const c of chunks) {
				const anchor = c.heading?.id ?? '';
				const id = anchor ? `${slug}#${anchor}` : slug;
				const existing = by_key.get(id);
				if (existing) {
					existing.text = `${existing.text} ${c.text}`.trim();
					continue;
				}
				const doc: SearchDoc = {
					id,
					slug,
					anchor,
					title,
					section: hit.record.section,
					heading: c.heading?.text ?? '',
					text: c.text
				};
				by_key.set(id, doc);
				docs.push(doc);
			}
		} else {
			// Data-only entry (JSON/CMS without source): index its display fields.
			const summary = typeof data.summary === 'string' ? data.summary : '';
			const extra = Object.values(entry.data)
				.filter((v): v is string => typeof v === 'string')
				.join(' ');
			docs.push({ id: slug, slug, anchor: '', title, section: hit.record.section, heading: '', text: strip_prose(`${summary} ${extra}`) });
		}
	}
	return docs;
}

function extract_headings(meta: unknown): Heading[] {
	if (meta && typeof meta === 'object' && 'headings' in meta) {
		const h = (meta as { headings: unknown }).headings;
		if (Array.isArray(h)) return h as Heading[];
	}
	return [];
}

// ── the default engine: Orama (optional peer, lazy) ─────────────────────────

type OramaModule = typeof import('@orama/orama');

async function load_orama(): Promise<OramaModule> {
	try {
		return await import('@orama/orama');
	} catch {
		throw new Error(
			'[ogygia/pharos] search needs the optional peer dependency "@orama/orama". Install it:\n' +
				'  npm i @orama/orama   (or the pnpm / yarn / bun equivalent)'
		);
	}
}

const ESC_RX = /[.*+?^${}()|[\]\\]/g;
const esc_html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A match-centered excerpt with the query terms wrapped in `<mark>` — the window starts just before
 * the FIRST term occurrence (not the chunk start). Output is HTML-escaped first, so the consumer
 * renders it with `{@html}` safely; `<mark>` is the only markup.
 */
export function excerpt_of(text: string, terms: string[], span = 150): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i > -1 && (at === -1 || i < at)) at = i;
	}
	const start = at <= 40 ? 0 : at - 40;
	let out = esc_html(text.slice(start, start + span));
	for (const t of [...terms].sort((a, b) => b.length - a.length)) {
		out = out.replace(new RegExp(`(${esc_html(t).replace(ESC_RX, '\\$&')})`, 'gi'), '<mark>$1</mark>');
	}
	return (start > 0 ? '…' : '') + out + (start + span < text.length ? '…' : '');
}

/** Title-match re-rank: a hit whose TITLE carries the query outranks body matches (svelte.dev's
 *  feel — searching "snippet" puts the `{#snippet …}` page first, sections after). */
export function rerank(hits: SearchHit[], query: string): SearchHit[] {
	const q = query.toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	const scored = hits.map((h) => {
		const title = h.title.toLowerCase();
		const heading = (h.heading ?? '').toLowerCase();
		let m = 1;
		if (title.includes(q)) m *= 4;
		else if (terms.every((t) => title.includes(t))) m *= 2;
		if (heading && terms.every((t) => heading.includes(t))) m *= 1.5;
		// the PAGE doc (no anchor) with a matching title is the canonical entry — nudge it up
		if (!h.href.includes('#') && title.includes(q)) m *= 1.5;
		return { ...h, score: h.score * m };
	});
	return scored.sort((a, b) => b.score - a.score);
}

/** The default engine — Orama over the section documents, title/heading boosted. */
export function orama_engine(): SearchEngine {
	let mod: OramaModule | null = null;
	return {
		async init() {
			mod ??= await load_orama();
		},
		async build(docs) {
			mod ??= await load_orama();
			const db = mod.create({
				schema: { title: 'string', heading: 'string', text: 'string', section: 'string' }
			});
			const by_id = new Map<string, SearchDoc>();
			// Insert under a synthetic per-row id (the array index), NOT `d.id`: Orama's `insert` throws
			// on a repeated id, and a single duplicate would abort the WHOLE index build. Decoupling the
			// engine's id from the doc's slug-id makes the build robust to any accidental collision.
			docs.forEach((d, i) => {
				const rid = String(i);
				by_id.set(rid, d);
				mod!.insert(db, { id: rid, title: d.title, heading: d.heading, text: d.text, section: d.section });
			});
			return {
				async query(q, { limit, base }) {
					// Over-fetch, then re-rank by title match and trim — orama's tf scoring alone lets
					// term-dense body chunks outrank the page whose TITLE is the query.
					const res = await mod!.search(db, {
						term: q,
						limit: limit * 3,
						boost: { title: 3, heading: 2, text: 1 },
						tolerance: 1
					});
					const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
					const hits: SearchHit[] = [];
					for (const h of res.hits) {
						const doc = by_id.get(String(h.id));
						if (!doc) continue;
						hits.push({
							href: href_of(base, doc.slug) + (doc.anchor ? `#${doc.anchor}` : ''),
							slug: doc.slug,
							title: doc.title,
							section: doc.section,
							heading: doc.heading,
							excerpt: excerpt_of(doc.text, terms),
							score: h.score
						});
					}
					return rerank(hits, q).slice(0, limit);
				}
			};
		}
	};
}

// ── the brain: lazy, memoized, version-invalidated ──────────────────────────

export type SearchBrain = (q: string, opts?: SearchOptions) => Promise<SearchHit[]>;

/**
 * Create `site.search`. The index builds on first query (single-flight), from ALL leaves (or the
 * scoped subset — each distinct scope gets its own memoized index). Rebuilds when any contributing
 * collection's catalog version changes (live sources).
 */
export function create_search(ol: Outline, engine: SearchEngine): SearchBrain {
	// One memoized index per distinct scope (base is applied at query time, not indexed).
	const cache = new Map<string, Promise<SearchIndex>>();

	return async (q, opts = {}) => {
		const query = q.trim();
		if (!query) return [];
		const limit = opts.limit ?? 10;
		const base = opts.base ?? '';
		const scope_id = opts.in ? opts.in.map((c) => scope_tag(c)).join(',') : '*';
		let index = cache.get(scope_id);
		if (!index) {
			index = (async () => {
				await engine.init?.();
				return engine.build(await build_docs(ol, opts.in));
			})();
			cache.set(scope_id, index);
		}
		return (await index).query(query, { limit, base });
	};
}

// Identity tags for scope memo keys (WeakMap-backed counter; no naming registry).
const scope_tags = new WeakMap<object, number>();
let scope_seq = 0;
function scope_tag(c: Collection): number {
	let t = scope_tags.get(c);
	if (t === undefined) {
		t = ++scope_seq;
		scope_tags.set(c, t);
	}
	return t;
}

export type { LinkRef };
