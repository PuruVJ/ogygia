/**
 * Built-in source builders. Each wraps a raw record source (a glob, or your API) with a parse step
 * and returns a {@link Source} — so `content({ from: mdsvex(import.meta.glob(...)) })`. Heavy deps
 * (the `yaml` parser) load lazily in `init()`, so importing these pulls nothing extra and they can
 * all live on `ogygia/content`.
 *
 * Two typed axes: `data` (authored, schema-validated) and `meta` (format-derived, typed here).
 */
import type { Component } from 'svelte';
import type { Heading } from './index.js';
import { region } from '../region.js';
import { defineSource, toRawSource, type Format, type GlobMap, type RawSource, type Source } from './source.js';

type Input<V> = GlobMap | RawSource<V>;
type BuilderOpts = { id?: (key: string) => string };

/** If Vite wrapped a lone `default` export, unwrap it. */
function unwrap_default(resolved: unknown): unknown {
	if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return resolved;
	const mod = resolved as Record<string, unknown>;
	if (!('default' in mod)) return resolved;
	const keys = Object.keys(mod).filter((k) => k !== '__esModule');
	if (keys.length === 1 && keys[0] === 'default') return mod.default;
	return resolved;
}

function as_object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			`[@ogygia/content] ${label}: expected a plain object (got ${Array.isArray(value) ? 'array' : typeof value})`
		);
	}
	return value as Record<string, unknown>;
}

// ── mdsvex ────────────────────────────────────────────────────────────────────

/** Meta the mdsvex source derives: the h2–h4 headings collected during compile (for a TOC). */
export type MdsvexMeta = { headings: Heading[] };

const mdsvex_format: Format<unknown, MdsvexMeta> = (resolved, id) => {
	if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
		throw new Error(`[@ogygia/content] mdsvex: ${id}: expected a module with metadata`);
	}
	const mod = resolved as Record<string, unknown>;
	if (!('metadata' in mod)) {
		throw new Error(`[@ogygia/content] mdsvex: ${id}: missing metadata (is mdsvex configured?)`);
	}
	const meta = as_object(mod.metadata ?? {}, `mdsvex:${id}`);
	const { headings, ...data } = meta as { headings?: Heading[] } & Record<string, unknown>;
	return {
		data,
		...(mod.default !== undefined
			? { body: region(mod.default as Component<Record<string, never>>, {}) }
			: {}),
		meta: { headings: Array.isArray(headings) ? headings : [] }
	};
};

/** `.svx` / `.md` content compiled by the markdown pipeline — body is the component, meta has headings. */
export function mdsvex(input: Input<unknown>, opts: BuilderOpts = {}): Source<MdsvexMeta> {
	return defineSource(toRawSource(input, opts), mdsvex_format);
}

// ── json ────────────────────────────────────────────────────────────────────

const json_format: Format<unknown> = (resolved, id) => ({
	data: as_object(unwrap_default(resolved), `json:${id}`)
});

/** JSON modules — a plain object, or `{ default: object }`. Data-only (no body). */
export function json(input: Input<unknown>, opts: BuilderOpts = {}): Source {
	return defineSource(toRawSource(input, opts), json_format);
}

// ── yaml (lazy parser) ────────────────────────────────────────────────────────

/** YAML strings (`import.meta.glob(..., { query: '?raw' })`) parsed with the `yaml` package (lazy). */
export function yaml(input: Input<unknown>, opts: BuilderOpts = {}): Source {
	let parseYaml: (s: string) => unknown = () => {
		throw new Error('[@ogygia/content] yaml source used before init()');
	};
	const format: Format<unknown> = (resolved, id) => {
		const value = unwrap_default(resolved);
		let data: unknown;
		if (typeof value === 'string') {
			try {
				data = parseYaml(value);
			} catch (e) {
				throw new Error(`[@ogygia/content] yaml: ${id}: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			data = value;
		}
		return { data: as_object(data, `yaml:${id}`) };
	};
	return defineSource(toRawSource(input, opts), format, {
		init: async () => {
			({ parse: parseYaml } = await import('yaml'));
		}
	});
}

// ── raw ────────────────────────────────────────────────────────────────────

const raw_format: Format<unknown> = (resolved, id) => {
	const value = unwrap_default(resolved);
	if (typeof value !== 'string') {
		throw new Error(`[@ogygia/content] raw: ${id}: expected a string (got ${typeof value})`);
	}
	return { data: { body: value } };
};

/** Raw string body as `{ body: string }` — use with `import.meta.glob(..., { query: '?raw' })`. */
export function raw(input: Input<unknown>, opts: BuilderOpts = {}): Source {
	return defineSource(toRawSource(input, opts), raw_format);
}
