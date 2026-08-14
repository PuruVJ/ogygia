/**
 * `folder()` — the filesystem-convention preset. One glob of `{+doc.svx,+meta.json}` in, a full
 * {@link Source} out: it splits the map by basename, derives clean ids (shared-prefix strip + `NN-`
 * strip), computes each entry's sibling `order`, exposes `+meta.json` labels through the `groups()`
 * facet, and verifies sibling numbering at first read. The weave then reads `order`/`groups` as DATA
 * and parses no filename.
 *
 * This is the ONLY place `+doc.svx` / `+meta.json` / `NN-` knowledge lives. A CMS never touches it —
 * its loader fills `order`/`groups` from its own fields. Throw a stray file at `folder()` and it errors
 * (catches a too-wide `**\/*` glob before colocated components reach the bundle).
 *
 * ```ts
 * content({ loader: folder(import.meta.glob('../content/docs/**\/{+doc.svx,+meta.json}', { eager: true })) })
 * content({ loader: folder(map, (raw) => blocks(raw, registry)) })   // any format; default markdown
 * ```
 */
import { numbered, read_meta, strip_order_prefix, title_case, type Convention, type MetaDecoration } from './convention.js';
import { markdown } from './formats.js';
import type { GlobMap, RawRecord, RawSource, Source } from './source.js';

const BACKSLASH = /\\/g;
const norm = (k: string) => k.replace(BACKSLASH, '/').split('?')[0];

export type FolderOptions<Meta> = {
	/** Which keys are pages (become entries). Default: `+doc.svx` / `+doc.md` / `index.*`. */
	page?: RegExp;
	/** Which keys are directory sidecars. Default: `+meta.json`. `false` = no sidecars. */
	meta?: RegExp | false;
	/** The sibling-ordering convention. Default {@link numbered}. */
	convention?: Convention;
	/** The format builder wrapping the page files. Default {@link markdown}. */
	format?: (input: RawSource<unknown>) => Source<Meta>;
};

const DEFAULT_PAGE = /\/(\+doc|index)\.[^./]+$/;
const DEFAULT_META = /\/\+meta\.json$/;

/** Longest shared directory prefix across all keys — pages anchor it, so a lone meta file can't over-strip. */
function common_prefix(keys: string[]): string {
	const parts = keys.map(norm);
	let prefix = parts[0] ? parts[0].slice(0, parts[0].lastIndexOf('/') + 1) : '';
	for (const p of parts.slice(1)) {
		while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
	}
	return prefix;
}

/** If Vite wrapped a lone JSON `default` export, unwrap it. */
function unwrap(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const mod = value as Record<string, unknown>;
		const keys = Object.keys(mod).filter((k) => k !== '__esModule');
		if (keys.length === 1 && keys[0] === 'default') return unwrap(mod.default);
		return mod;
	}
	return {};
}

export function folder<Meta = Record<string, never>>(map: GlobMap, opts: FolderOptions<Meta> = {}): Source<Meta> {
	const page_rx = opts.page ?? DEFAULT_PAGE;
	const meta_rx = opts.meta ?? DEFAULT_META;
	const conv = opts.convention ?? numbered();
	const build = opts.format ?? (markdown as unknown as (input: RawSource<unknown>) => Source<Meta>);

	const prefix = common_prefix(Object.keys(map));
	const rel = (key: string) => norm(key).slice(prefix.length);

	const page_map: GlobMap = {};
	const meta_entries: Array<{ dir: string; value: unknown }> = [];
	// For verification: each directory's raw child segments, and its `+meta.json` decoration.
	const siblings = new Map<string, Set<string>>();
	const decorations = new Map<string, MetaDecoration>();

	/** Structural raw segments of a page key: rel path minus the page-file part. */
	const raw_segments = (key: string) => {
		const r = rel(key).replace(page_rx, '');
		return r.split('/').filter(Boolean);
	};

	for (const key of Object.keys(map)) {
		const k = norm(key);
		// Sidecars are matched BEFORE pages: a file-page convention needs `page: /\.md$/` (so the
		// filename survives as an id segment), which also matches a section-label `index.md`. Meta-first
		// lets that `index.md` be the label, not a bodyless junk page. Safe for the `+doc.svx`/`+meta.json`
		// defaults — those regexes don't overlap, so order can't change their outcome.
		if (meta_rx && meta_rx.test(k)) {
			const dir = rel(key).replace(meta_rx, '').split('/').map(strip_order_prefix).filter(Boolean).join('/');
			meta_entries.push({ dir, value: map[key] });
			const mod = unwrap(map[key]);
			const deco = read_meta(mod);
			// An `index.md` sidecar (the svelte.dev convention) is a compiled markdown MODULE — its
			// frontmatter `title` is the section label ("Template syntax", not the title-cased slug).
			const fm = (mod as { metadata?: { title?: unknown } }).metadata;
			if (deco.label === undefined && typeof fm?.title === 'string') deco.label = fm.title;
			decorations.set(dir, deco);
		} else if (page_rx.test(k)) {
			page_map[key] = map[key];
			// Register each level's sibling set for verify().
			const segs = raw_segments(key);
			for (let d = 0; d < segs.length; d++) {
				const parent = segs.slice(0, d).map(strip_order_prefix).join('/');
				(siblings.get(parent) ?? siblings.set(parent, new Set()).get(parent)!).add(segs[d]);
			}
		} else {
			throw new Error(`[ogygia/content] folder(): unexpected file '${key}' — expected a page (${page_rx}) or sidecar (${meta_rx || 'none'}). A '**/*' glob drags colocated components into the bundle; narrow it.`);
		}
	}

	const page_id = (key: string) => raw_segments(key).map((s) => conv.segment(s).slug).join('/');
	const page_order = (key: string): number[] => raw_segments(key).map((s) => conv.segment(s).order);

	// The clean group path → its label (decoration wins, else title-cased last segment).
	const group_map = new Map<string, { label?: string }>();
	for (const { dir } of meta_entries) {
		const deco = decorations.get(dir);
		const last = dir.split('/').pop() ?? '';
		group_map.set(dir, { label: deco?.label ?? title_case(last) });
	}

	// Verify sibling numbering once, at first read (build-error voice).
	const verify = () => {
		const errors: string[] = [];
		for (const [dir, set] of siblings) errors.push(...conv.verify(dir, [...set], decorations.get(dir)));
		if (errors.length) throw new Error(`[ogygia/content] folder(): ${errors.join('; ')}`);
	};

	// Build the page raw source directly (ids/order baked here), then hand it to the format builder.
	const load = async (key: string) => {
		const v = map[key];
		return typeof v === 'function' ? await (v as () => Promise<unknown>)() : v;
	};
	const keys_by_id = new Map<string, string>();
	for (const key of Object.keys(page_map)) {
		const id = page_id(key);
		if (!id) throw new Error(`[ogygia/content] folder(): empty id for '${key}'`);
		if (keys_by_id.has(id)) throw new Error(`[ogygia/content] folder(): duplicate id '${id}' ('${key}')`);
		keys_by_id.set(id, key);
	}
	const record = async (id: string, key: string): Promise<RawRecord<unknown>> => ({
		id,
		value: await load(key),
		order: page_order(key),
		filePath: norm(key)
	});

	const page_raw: RawSource<unknown> = {
		init: async () => verify(),
		refs: () => Promise.all([...keys_by_id].map(([id, key]) => record(id, key))),
		async get(id) {
			const key = keys_by_id.get(id);
			return key ? record(id, key) : null;
		},
		groups: async () => group_map
	};

	return build(page_raw);
}
