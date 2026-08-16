/**
 * `dimensions()` — the i18n / versioning primitive, kept true to the doctrine: a dimension is an
 * AXIS (version, locale), content is the MATRIX of coordinates, and the outline is woven PER
 * coordinate. `class Dimensions` wraps N outlines into ONE `Outline` the same `contentkit()` consumes —
 * the coordinate is parsed off the FRONT of the slug (no route changes; the default coordinate is bare).
 *
 * Design decisions (see internal/notes/ogygia.md), learned from Starlight / Fumadocs / Docusaurus:
 *  - FALLBACK is render-at-every-URL, not 404. An untranslated page serves the default coordinate's
 *    content at the localized URL with a `fallback` flag — which kills the dead-language-switcher
 *    failure class every other framework fights (the switcher can always link the same slug).
 *  - The default value of an axis is BARE in the URL; non-defaults get a leading segment, in axis
 *    declaration order (`/v1/fr/x`, `/fr/x`, `/v1/x`, `/x`).
 *  - Coordinate is threaded as DATA (slug → coordinate), never module-global — SSR-safe by
 *    construction (no AsyncLocalStorage needed; the brains already pass everything by argument).
 *  - `entries()` bakes the UNION across the matrix, so a page that exists only in one coordinate
 *    still prerenders — the "exists only in French" hole Docusaurus has.
 *
 * Versions are just collections: hand `weave` whichever collection sources a coordinate. ogygia does
 * not copy trees or read git — sourcing a version is the app's concern.
 */
import { outline, href_of, type Outline, type OutlineSpec, type ReadContext, type TrailScope } from './outline.js';
import type { NavRef, NavTree } from './types.js';

/** One axis of the content matrix. */
export type Axis = {
	/** All values, in switcher order. The first is used if `default` is omitted. */
	values: string[];
	/** The value served at the BARE (un-prefixed) URL. Defaults to `values[0]`. */
	default?: string;
	/** Missing page in a non-default value → serve the default value's content (render, not 404). */
	fallback?: boolean;
	/** Human label for the switcher (defaults to the axis name, title-cased). */
	label?: string;
};

/** A point in the matrix — `{ version: 'v1', locale: 'fr' }`. */
export type Coordinate = Record<string, string>;

export type DimensionsSpec = {
	axes: Record<string, Axis>;
	/** Weave the outline for one coordinate. Called once per distinct coordinate (memoized). */
	weave: (coord: Coordinate) => Outline | OutlineSpec | Promise<Outline | OutlineSpec>;
};

/** One axis of the switcher: where you are on it, and where each value would take you. */
export type SwitcherAxis = {
	axis: string;
	label: string;
	current: string;
	options: Array<{ value: string; href: string; current: boolean; missing: boolean }>;
};
export type Switcher = SwitcherAxis[];

/** What fell back for a page (which axis, from → to), or null when the page is native. */
export type Fallback = { axis: string; from: string; to: string } | null;

/** An `Outline` with the coordinate extras `contentkit()` surfaces (switcher, fallback, coordinate). */
export interface Dimensioned extends Outline {
	readonly __dimensioned: true;
	axes: Record<string, Axis>;
	/** The nav tree for `coord` (default coordinate when omitted), hrefs baked for `base`, read context `ctx`. */
	tree(base?: string, coord?: Coordinate, ctx?: ReadContext): Promise<NavTree>;
	/** The coordinate encoded in a full slug (defaults filled for absent axes). */
	coordinateOf(slug: string): Coordinate;
	/** The DEFAULT coordinate's bare addresses — the canonical set to index for search (so fallback
	 *  pages under other coordinates don't show as duplicate hits). */
	canonicalAddresses(ctx?: ReadContext): Promise<string[]>;
	/** The switcher for the coordinate in `slug`, hrefs baked for `base`. */
	switcher(slug: string, base?: string, ctx?: ReadContext): Promise<Switcher>;
	/** Which axis (if any) fell back resolving `slug`. */
	fallbackOf(slug: string, ctx?: ReadContext): Promise<Fallback>;
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.replace(/^\/+|\/+$/g, '');
/** Join slug-ish parts into a BARE slug (no leading slash — `href_of` adds the base). */
const join = (...parts: string[]) => parts.map(clean).filter(Boolean).join('/');
/** Append a coordinate prefix to a mount base, PRESERVING the base's leading slash. */
const base_join = (base: string, prefix: string) =>
	prefix ? `${base.replace(/\/+$/, '')}/${prefix}` : base;

class Dimensions implements Dimensioned {
	readonly __dimensioned = true as const;
	readonly axes: Record<string, Axis>;

	readonly #spec: DimensionsSpec;
	readonly #names: string[];
	/** One memoized Outline per distinct coordinate — woven on first touch. */
	readonly #cache = new Map<string, Promise<Outline>>();

	constructor(spec: DimensionsSpec) {
		this.#spec = spec;
		this.#names = Object.keys(spec.axes);
		if (this.#names.length === 0) throw new Error('[ogygia/content] dimensions() needs at least one axis.');
		for (const name of this.#names) {
			if (!spec.axes[name].values.includes(this.#def(name))) {
				throw new Error(`[ogygia/content] axis "${name}": default "${this.#def(name)}" is not in values.`);
			}
		}
		this.axes = spec.axes;
	}

	#def(name: string) {
		return this.#spec.axes[name].default ?? this.#spec.axes[name].values[0];
	}

	/** Encode a coordinate to its URL prefix — non-default values in axis order, defaults omitted. */
	#encode(coord: Coordinate) {
		return this.#names
			.map((n) => coord[n] ?? this.#def(n))
			.filter((v, i) => v !== this.#def(this.#names[i]))
			.join('/');
	}

	/** Peel the coordinate prefix off the front of a slug. Greedy, in axis order: a leading segment
	 *  that is a non-default value of the next axis is consumed; otherwise that axis stays default. */
	#peel(slug: string): { coord: Coordinate; rest: string } {
		const parts = clean(slug).split('/').filter(Boolean);
		const coord: Coordinate = {};
		for (const n of this.#names) coord[n] = this.#def(n);
		let i = 0;
		for (const n of this.#names) {
			const seg = parts[i];
			if (seg !== undefined && seg !== this.#def(n) && this.#spec.axes[n].values.includes(seg)) {
				coord[n] = seg;
				i++;
			}
		}
		return { coord, rest: parts.slice(i).join('/') };
	}

	#key(coord: Coordinate) {
		return this.#names.map((n) => coord[n] ?? this.#def(n)).join('\0');
	}

	#outline_for(coord: Coordinate): Promise<Outline> {
		const key = this.#key(coord);
		let p = this.#cache.get(key);
		if (!p) {
			const full: Coordinate = {};
			for (const n of this.#names) full[n] = coord[n] ?? this.#def(n);
			p = Promise.resolve(this.#spec.weave(full)).then((r) => (is_outline(r) ? r : outline(r as OutlineSpec)));
			this.#cache.set(key, p);
		}
		return p;
	}

	/** The coordinate with every fallback-enabled axis reset to its default (the fallback source). */
	#fallback_coord(coord: Coordinate): Coordinate | null {
		let changed = false;
		const fb: Coordinate = {};
		for (const n of this.#names) {
			const cur = coord[n] ?? this.#def(n);
			if (this.#spec.axes[n].fallback && cur !== this.#def(n)) {
				fb[n] = this.#def(n);
				changed = true;
			} else fb[n] = cur;
		}
		return changed ? fb : null;
	}

	/** Resolve `rest` in `coord`, then (if enabled) in the fallback coordinate. Returns the hit plus
	 *  which coordinate actually served it (for the fallback flag). `ctx` threads to each inner weave. */
	async #resolve_in(coord: Coordinate, rest: string, ctx: ReadContext = {}) {
		const own = await (await this.#outline_for(coord)).resolve(rest, ctx);
		if (own) return { hit: own, served: coord };
		const fb = this.#fallback_coord(coord);
		if (fb) {
			const alt = await (await this.#outline_for(fb)).resolve(rest, ctx);
			if (alt) return { hit: alt, served: fb };
		}
		return null;
	}

	/** Bare addresses reachable at a coordinate = its own pages ∪ (fallback source's pages). */
	async #reachable(coord: Coordinate, ctx: ReadContext = {}): Promise<string[]> {
		const own = await (await this.#outline_for(coord)).addresses(ctx);
		const fb = this.#fallback_coord(coord);
		if (!fb) return own;
		const alt = await (await this.#outline_for(fb)).addresses(ctx);
		return [...new Set([...own, ...alt])];
	}

	/** The full matrix (cartesian product of axis values). */
	#matrix(): Coordinate[] {
		let acc: Coordinate[] = [{}];
		for (const n of this.#names) {
			acc = acc.flatMap((c) => this.#spec.axes[n].values.map((v) => ({ ...c, [n]: v })));
		}
		return acc;
	}

	#prefix_slug(coord: Coordinate, bare: string) {
		return join(this.#encode(coord), bare);
	}

	coordinateOf(slug: string): Coordinate {
		return this.#peel(slug).coord;
	}

	async canonicalAddresses(ctx: ReadContext = {}): Promise<string[]> {
		const def_coord: Coordinate = {};
		for (const n of this.#names) def_coord[n] = this.#def(n);
		return (await this.#outline_for(def_coord)).addresses(ctx);
	}

	async fallbackOf(slug: string, ctx: ReadContext = {}): Promise<Fallback> {
		const { coord, rest } = this.#peel(slug);
		const r = await this.#resolve_in(coord, rest, ctx);
		if (!r || this.#key(r.served) === this.#key(coord)) return null;
		for (const n of this.#names) {
			if ((coord[n] ?? this.#def(n)) !== (r.served[n] ?? this.#def(n))) {
				return { axis: n, from: coord[n] ?? this.#def(n), to: r.served[n] ?? this.#def(n) };
			}
		}
		return null;
	}

	async switcher(slug: string, base = '', ctx: ReadContext = {}): Promise<Switcher> {
		const { coord, rest } = this.#peel(slug);
		const out: Switcher = [];
		for (const n of this.#names) {
			const options = [];
			for (const value of this.#spec.axes[n].values) {
				const target: Coordinate = { ...coord, [n]: value };
				const r = await this.#resolve_in(target, rest, ctx);
				// Where this value takes you: the same page under the new coordinate. If it neither
				// exists nor falls back there, link to that coordinate's HOME (first reachable page) —
				// never the bare coordinate root, which isn't a page and 404s the prerender crawler.
				const bare = r ? rest : ((await this.#reachable(target, ctx))[0] ?? '');
				options.push({
					value,
					href: href_of(base, this.#prefix_slug(target, bare)),
					current: value === (coord[n] ?? this.#def(n)),
					missing: !r
				});
			}
			out.push({ axis: n, label: this.#spec.axes[n].label ?? title(n), current: coord[n] ?? this.#def(n), options });
		}
		return out;
	}

	async tree(base = '', coord?: Coordinate, ctx: ReadContext = {}): Promise<NavTree> {
		const c = coord ?? {};
		return (await this.#outline_for(c)).tree(base_join(base, this.#encode(c)), ctx);
	}

	async resolve(slug: string, ctx: ReadContext = {}) {
		const { coord, rest } = this.#peel(slug);
		const r = await this.#resolve_in(coord, rest, ctx);
		if (!r) return null;
		// Re-prefix the record's slug to the FULL address (coordinate of the URL, not of the served
		// content) so hrefs and neighbor lookups round-trip through this wrapper.
		const full = this.#prefix_slug(coord, r.hit.record.slug);
		return { collection: r.hit.collection, record: { ...r.hit.record, slug: full } };
	}

	async addresses(ctx: ReadContext = {}): Promise<string[]> {
		const all: string[] = [];
		for (const coord of this.#matrix()) {
			for (const bare of await this.#reachable(coord, ctx)) all.push(this.#prefix_slug(coord, bare));
		}
		return [...new Set(all)];
	}

	async neighbors(slug: string, base = '', ctx: ReadContext = {}, scope: TrailScope = 'weave') {
		const { coord, rest } = this.#peel(slug);
		const inner = await this.#outline_for(coord);
		const { prev, next } = await inner.neighbors(rest, base_join(base, this.#encode(coord)), ctx, scope);
		const reslug = (ref?: NavRef) => (ref ? { ...ref, slug: this.#prefix_slug(coord, ref.slug) } : undefined);
		return { ...(prev ? { prev: reslug(prev)! } : {}), ...(next ? { next: reslug(next)! } : {}) };
	}

	async slug_for(collection: Parameters<Outline['slug_for']>[0], entryId: string, ctx: ReadContext = {}) {
		// Graph relations resolve within the entry's own coordinate; we don't know it here, so try
		// each coordinate's outline and prefix the first hit. Bare slug returned unprefixed is fine
		// for same-coordinate relations (the common case).
		for (const coord of this.#matrix()) {
			const inner = await this.#outline_for(coord);
			const bare = await inner.slug_for(collection, entryId, ctx);
			if (bare !== undefined) return this.#prefix_slug(coord, bare);
		}
		return undefined;
	}

	async alias(slug: string, ctx: ReadContext = {}) {
		const { coord, rest } = this.#peel(slug);
		const canonical = await (await this.#outline_for(coord)).alias(rest, ctx);
		return canonical === undefined ? undefined : this.#prefix_slug(coord, canonical);
	}

	async aliases(ctx: ReadContext = {}) {
		const out = new Map<string, string>();
		for (const coord of this.#matrix()) {
			const inner = await this.#outline_for(coord);
			for (const [old_slug, canonical] of await inner.aliases(ctx)) {
				out.set(this.#prefix_slug(coord, old_slug), this.#prefix_slug(coord, canonical));
			}
		}
		return out;
	}
}

/** Mint a dimensioned outline — the i18n/versioning wrapper `contentkit()` consumes like any outline. */
export function dimensions(spec: DimensionsSpec): Dimensioned {
	return new Dimensions(spec);
}

/** Narrow an unknown to a `Dimensioned` outline. */
export function is_dimensioned(x: unknown): x is Dimensioned {
	return !!x && typeof x === 'object' && (x as Dimensioned).__dimensioned === true;
}

function is_outline(x: unknown): x is Outline {
	return (
		!!x &&
		typeof x === 'object' &&
		typeof (x as Outline).tree === 'function' &&
		typeof (x as Outline).resolve === 'function' &&
		typeof (x as Outline).addresses === 'function'
	);
}
