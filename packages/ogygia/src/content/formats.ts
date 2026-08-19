/**
 * Built-in source builders. Each wraps a raw record source (a glob, or your API) with a parse step
 * and returns a {@link Source} — so `content({ from: markdown(import.meta.glob(...)) })`. Heavy deps
 * (the `yaml` parser) load lazily in `init()`, so importing these pulls nothing extra and they can
 * all live on `ogygia/content`.
 *
 * Two typed axes: `data` (authored, schema-validated) and `meta` (format-derived, typed here).
 */
import type { Component } from 'svelte';
import type { Heading, LinkRef } from './index.js';
import { prebaked_region, region } from '../region.js';
import { defineSource, toRawSource, type Format, type GlobMap, type RawSource, type Source } from './source.js';

type Input<V> = GlobMap | RawSource<V>;
export type BuilderOpts = { id?: (key: string) => string };

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
			`[ogygia/content] ${label}: expected a plain object (got ${Array.isArray(value) ? 'array' : typeof value})`
		);
	}
	return value as Record<string, unknown>;
}

// ── markdown ────────────────────────────────────────────────────────────────────

/** Meta the markdown source derives: h2–h4 headings (for a TOC) and every markdown link (for the
 *  ogygia link audit), both collected during compile. */
export type MarkdownMeta = { headings: Heading[]; links: LinkRef[] };

const markdown_format: Format<unknown, MarkdownMeta> = (resolved, id) => {
	if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
		throw new Error(`[ogygia/content] markdown: ${id}: expected a module with metadata`);
	}
	const mod = resolved as Record<string, unknown>;
	if (!('metadata' in mod)) {
		throw new Error(`[ogygia/content] markdown: ${id}: missing metadata (is markdown configured?)`);
	}
	const meta = as_object(mod.metadata ?? {}, `markdown:${id}`);
	const { headings, links, ...data } = meta as { headings?: Heading[]; links?: LinkRef[] } & Record<string, unknown>;
	// The preprocessor injects a lazy `__ogygia_source` self-import (`() => import(self + '?raw')`)
	// when it compiles a `.svx` / `.md`. Surface it as the entry's `source`; absent in plain apps.
	const source = typeof mod.__ogygia_source === 'function' ? (mod.__ogygia_source as () => Promise<string>) : undefined;
	// A SERIALIZED-REGION module (the region emitter): the document HTML was baked at compile time and
	// rides `__ogygia_region`. The body is a pre-baked inline region — renders like any inline region
	// (the default export is the thin `{@html}` shell), but awaiting it is a no-op: no svelte/server
	// render on the wire path, the ticket carries this HTML directly.
	const baked = (mod.__ogygia_region as { html?: string } | undefined)?.html;
	// Content-body CSS key baked by the markdown preprocessor when the module has its own scoped
	// `<style>` — thread it onto the body region so Region.svelte links the client CSS asset the
	// plugin emitted (the corpus is server-only, so this CSS is on no page stylesheet). Absent → no link.
	const css_id = typeof mod.__ogygia_css === 'string' ? mod.__ogygia_css : undefined;
	return {
		data,
		...(mod.default !== undefined
			? {
					body:
						typeof baked === 'string'
							? prebaked_region(mod.default as Component<Record<string, never>>, baked, css_id)
							: region(mod.default as Component<Record<string, never>>, {}, undefined, css_id)
				}
			: {}),
		...(source ? { source } : {}),
		meta: { headings: Array.isArray(headings) ? headings : [], links: Array.isArray(links) ? links : [] }
	};
};

/** `.svx` / `.md` content compiled by the markdown pipeline — body is the component, meta has headings. */
export function markdown(input: Input<unknown>, opts: BuilderOpts = {}): Source<MarkdownMeta> {
	return defineSource(toRawSource(input, opts), markdown_format);
}

// ── json ────────────────────────────────────────────────────────────────────

const json_format: Format<unknown> = (resolved, id) => ({
	data: as_object(unwrap_default(resolved), `json:${id}`)
});

/** JSON modules — a plain object, or `{ default: object }`. Data-only (no body). */
export function json(input: Input<unknown>, opts: BuilderOpts = {}): Source {
	return defineSource(toRawSource(input, opts), json_format);
}

// NB: there are no built-in `yaml()` / `raw()` content sources. ogygia's own YAML parser is a
// frontmatter-only subset (see content/markdown/yaml.ts). A `.yaml` loader, or a raw-string loader
// (`import.meta.glob(..., { query: '?raw' })` → `{ body }`), is a short recipe — see the content docs.
