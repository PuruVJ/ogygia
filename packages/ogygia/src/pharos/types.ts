/**
 * Pharos data seams — the plain, serializable shapes every brain returns. Chrome and user code
 * consume ONLY these; nothing structural ever lives inside a component. `NavTree` is what a sidebar
 * renders; `DocView` is what a page renders. Both are devalue-safe (no bodies in `NavTree`; the one
 * `body` in `DocView` is the entry's inline `<Region>`, rendered in the page's own SSR pass).
 */
import type { ContentEntry, Entry, Heading } from '../content/index.js';

/** A shallow reference to one entry, ready to link: its address + display fields. */
export type NavRef = {
	/** Address within the outline (collection id, optionally prefixed by a group `base`). */
	slug: string;
	/** Resolved URL for the current mount (`base` + slug). */
	href: string;
	title: string;
	summary?: string;
};

/** A leaf in the nav tree — one content entry. */
export type NavLeaf = NavRef & {
	kind: 'leaf';
	badge?: string;
};

/** A group of nav items — a section (from convention) or an explicit outline group. */
export type NavGroup = {
	kind: 'group';
	label: string;
	collapsed?: boolean;
	badge?: string;
	items: NavItem[];
};

/** A plain link — points anywhere, external or otherwise; not backed by an entry. */
export type NavLink = {
	kind: 'link';
	label: string;
	href: string;
};

export type NavItem = NavGroup | NavLeaf | NavLink;

/** The serializable sidebar tree — what `site.nav()` returns and a sidebar brick renders. */
export type NavTree = NavItem[];

/** One breadcrumb step: a group label on the path from root to a leaf (`href` when it is a page). */
export type Crumb = { label: string; href?: string };

/**
 * Everything a single page position needs, as plain data. `entry` carries the inline `body` region;
 * everything else is derived from the outline and the content graph.
 */
export type DocView<Data extends Record<string, unknown> = Record<string, unknown>, Meta = unknown> = {
	slug: string;
	href: string;
	/** The resolved entry (`data`, `body`, `meta`, `rel`, `backlinks`) — render `entry.body`. */
	entry: Entry<Data, Meta>;
	/** Label of the top-level group containing this leaf (the "section"). */
	section: string;
	/** Group labels from root to this leaf. */
	crumbs: Crumb[];
	/** On-this-page headings (the outline recursing below the entry). */
	headings: Heading[];
	/** Neighboring and related pages, plus the policy-selected "keep reading" set. */
	trail: {
		prev?: NavRef;
		next?: NavRef;
		/** Content-graph `related` (from `rel.related`), resolved to refs. */
		related: NavRef[];
		/** `prevNext` policy applied: `'graph'` → related else [next]; `'order'` → [next]; `false` → []. */
		suggested: NavRef[];
	};
	/** On a `dimensions()` site: the coordinate this URL addresses (`{ version, locale }`). */
	coordinate?: Record<string, string>;
	/** On a `dimensions()` site: set when this page fell back to another axis value (e.g. untranslated
	 *  → default locale content served at the localized URL). Render a "not translated" notice. */
	fallback?: { axis: string; from: string; to: string } | null;
};

/** How "keep reading" is chosen. `'graph'` = content relations, order fallback. */
export type PrevNext = 'graph' | 'order' | false;

/** Per-render href option — the mount prefix the outline is served under. */
export type BaseOption = { base?: string };

/** Resolution of a slug back to its collection + entry id + placement in the tree. */
export type Resolved = {
	slug: string;
	entryId: string;
	/** Index into the flattened collection registry (internal addressing). */
	collectionIndex: number;
	section: string;
	crumbs: Crumb[];
	/** Source glob key of the entry, when it has one — the join key for raw-source emissions. */
	filePath?: string;
};

export type { ContentEntry, Entry, Heading };
