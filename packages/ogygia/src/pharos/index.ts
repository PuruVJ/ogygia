/**
 * Pharos — a docs kit that mounts on a SvelteKit route group (or the root) instead of owning the
 * repo. The capstone of the content pillar: a site is a corpus (one or more `content()` collections)
 * arranged by an `outline()`, projected through the brains this module mints with `pharos()`.
 *
 * **Browser-safe.** Import anywhere (routes, `+page`, islands, `.remote.ts`). The Kit remotes that an
 * island sidebar awaits are minted from `ogygia/pharos/server` in a `.remote.ts`.
 *
 * ```ts
 * import { content, markdown, json } from 'ogygia/content';
 * import { outline, pick, pharos } from 'ogygia/pharos';
 *
 * const guides = content({ loader: markdown(import.meta.glob('../content/**\/+doc.svx', { eager: true })), schema });
 * const meta   = content({ loader: json(import.meta.glob('../content/**\/+meta.json', { eager: true })) });
 *
 * export const site = pharos(outline([{ label: 'Guides', items: guides, meta }]), { prevNext: 'graph' });
 * ```
 */
export { outline, pick, href_of } from './outline.js';
export type { Outline, OutlineSpec, OutlineOptions, OutlineNode, OutlineThunk, GroupSpec, LinkSpec, Selection, Collection } from './outline.js';

export { pharos, mountBase } from './pharos.js';
export type { SiteData, ReadContext } from './pharos.js';
export { fields } from './fields.js';
export type { PageFields, PostFields, ChangeFields } from './fields.js';
export { dimensions, is_dimensioned } from './dimensions.js';
export type { Axis, Coordinate, DimensionsSpec, Dimensioned, Switcher, SwitcherAxis, Fallback } from './dimensions.js';
export type { Site, PharosOptions, EmitHandler, EmitOptions, LlmsEmitOptions, RawEmit, AuditOptions, AuditReport, AuditFinding, AuditRedirected } from './pharos.js';

export { orama_engine, build_docs, split_sections, strip_prose, create_search } from './search.js';
export type { SearchDoc, SearchHit, SearchEngine, SearchIndex, SearchOptions, SearchBrain } from './search.js';
export { search } from './search-client.js';
export type { SearchClient, SearchClientOptions } from './search-client.js';

// The filename convention moved to `ogygia/content` (ordering is generic corpus knowledge). Re-exported
// here for pharos consumers that reach for it by the old path.
export { title_case, strip_order_prefix, numbered } from '../content/convention.js';
export type { MetaDecoration, Convention, NumberedOptions } from '../content/convention.js';

// ── chrome: every component, one barrel (see ./components/index.ts — modern bundlers tree-shake
// barrels; import a brick, ship a brick). Styling is an EXPLICIT import:
// `import 'ogygia/pharos/theme.css'` — skip it for zero CSS.
export * from './components/index.js';
export { get_shell_context as getShellContext } from './context.js';
export type { ShellContext } from './context.js';

export type { NavTree, NavItem, NavGroup, NavLeaf, NavLink, NavRef, Crumb, DocView, PrevNext, BaseOption, Resolved } from './types.js';
