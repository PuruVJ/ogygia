/**
 * The site layer — mounts a docs/blog site on a SvelteKit route group (or the root) instead of owning
 * the repo. The capstone of the content pillar: a site is a corpus (one or more `content()`
 * collections) arranged by an `outline()`, projected through the brains `site()` mints.
 * Everything here surfaces through the ONE `ogygia/content` barrel.
 *
 * **Browser-safe.** Import anywhere (routes, `+page`, islands, `.remote.ts`). The Kit remotes that an
 * island sidebar awaits are minted from `ogygia/content/server` in a `.remote.ts`.
 *
 * ```ts
 * import { content, markdown, json, outline, site } from 'ogygia/content';
 *
 * const guides = content({ loader: markdown(import.meta.glob('../content/**\/+doc.svx', { eager: true })), schema });
 * const meta   = content({ loader: json(import.meta.glob('../content/**\/+meta.json', { eager: true })) });
 *
 * export const site = site(outline([{ label: 'Guides', items: guides, meta }]), { prevNext: 'graph' });
 * ```
 */
export { outline, pick, href_of as hrefOf } from './outline.js';
export type {
	Outline,
	OutlineSpec,
	OutlineOptions,
	OutlineNode,
	OutlineThunk,
	GroupSpec,
	LinkSpec,
	Selection,
	Collection,
	TrailScope
} from './outline.js';

export { site, mountBase } from './site.js';
export type { SiteData, SiteMeta, ReadContext } from './site.js';
export { fields } from './fields.js';
export type { PageFields, PostFields, ChangeFields, BlogPostRef } from './fields.js';
export { dimensions, is_dimensioned as isDimensioned } from './dimensions.js';
export type {
	Axis,
	Coordinate,
	DimensionsSpec,
	Dimensioned,
	Switcher,
	SwitcherAxis,
	Fallback
} from './dimensions.js';
export type {
	Site,
	SiteOptions,
	EmitHandler,
	EmitOptions,
	LlmsEmitOptions,
	RawEmit
} from './site.js';
export { links } from './checks.js';
export type { Check, Finding, Severity, CheckContext, LinkOptions } from './checks.js';

export {
	orama_engine as oramaEngine,
	build_docs as buildDocs,
	split_sections as splitSections,
	strip_prose as stripProse,
	create_search as createSearch
} from './search.js';
export type {
	SearchDoc,
	SearchHit,
	SearchEngine,
	SearchIndex,
	SearchOptions,
	SearchBrain
} from './search.js';
export { search } from './search-client.js';
export type { SearchClient, SearchClientOptions } from './search-client.js';

// ── chrome: every component, one barrel (see ./components/index.ts — modern bundlers tree-shake
// barrels; import a brick, ship a brick). Styling is an EXPLICIT import:
// `import 'ogygia/content/theme.css'` — skip it for zero CSS.
export * from './components/index.js';
export { get_shell_context as getShellContext } from './context.js';
export type { ShellContext } from './context.js';

export type {
	NavTree,
	NavItem,
	NavGroup,
	NavLeaf,
	NavLink,
	NavRef,
	Crumb,
	PageView,
	PrevNext,
	BaseOption,
	Resolved
} from './types.js';
