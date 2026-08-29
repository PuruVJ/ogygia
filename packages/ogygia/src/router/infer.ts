/**
 * `$infer` — the ONE type map an app exports (`export type App = typeof app.$infer`). Components index
 * it: `App['/docs/[slug]']` for a page (`{ data, form, params, search }`), `App['(admin)']` for a
 * layout (`{ data, children }`). Computed from the table's LOADS + input schemas only (never from
 * components — that keeps the dependency acyclic; the component declaration `App['/path']` IS the
 * check, like Kit's $types).
 *
 * `data` is the MERGED branch type (Kit's cascade): a page merges root→…→own load; a layout merges
 * its ancestors + own. See internal/notes/router-v2.md.
 */
import type { Snippet } from 'svelte';
import type { LoadDef, LayoutDef, PageDef, RouteTable, VerbEntry } from './define.js';
import type { ActionFailure } from './respond.js';
import type { Params, Simplify, StandardSchemaV1, InferOutput } from './view.js';

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
	k: infer I
) => void
	? I
	: never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPageDef = PageDef<any, any, any, any, any>;

/** The data a load contributes — a `load()` wrapper OR a bare function (both authoring forms). `{}`
 *  when absent / non-object. LoadDef is checked first (it is itself callable). A `Response` arm is
 *  the load's SHORT-CIRCUIT (the dispatcher returns it verbatim and never renders the component), so
 *  it is excluded from `data` — the component only ever sees the non-Response arm. */
type Obj<D> = D extends object ? D : {};
type Data_<D> = Obj<Exclude<D, Response>>;
type DataOf<L> =
	L extends LoadDef<infer D, string>
		? Data_<D>
		: L extends (c: never) => infer R
			? Data_<Awaited<R>>
			: {};
type LayoutData<L> = L extends LayoutDef<string, infer LD> ? DataOf<LD> : {};

/** Merge a layout chain's data (outermost-first) — the whole tuple. */
type ChainData<Ls extends readonly LayoutDef[]> = Ls extends readonly [infer H, ...infer R]
	? LayoutData<H> & (R extends readonly LayoutDef[] ? ChainData<R> : {})
	: {};

// The five generics of a PageDef, destructured once (5-slot infer so a fully-instantiated def matches).
type Layouts<V> = V extends PageDef<infer L, unknown, unknown, unknown, unknown> ? L : readonly [];
type LoadType<V> =
	V extends PageDef<readonly LayoutDef[], infer Load, unknown, unknown, unknown> ? Load : undefined;
type ActionsType<V> =
	V extends PageDef<readonly LayoutDef[], unknown, infer A, unknown, unknown> ? A : undefined;
type ParamsSchemaType<V> =
	V extends PageDef<readonly LayoutDef[], unknown, unknown, infer PS, unknown> ? PS : undefined;
type SearchSchemaType<V> =
	V extends PageDef<readonly LayoutDef[], unknown, unknown, unknown, infer SS> ? SS : undefined;

/** A page's merged `data`: its layout chain's data ∧ its own load's data (Kit's PageData). */
type PageData<V> = ChainData<Layouts<V>> & DataOf<LoadType<V>>;

/** The `form` prop: union of the page's action returns, unwrapping `fail(status, F)` → `F`; `null`
 *  when there are no actions (Kit's ActionData shape). Redirects throw, so contribute nothing. */
type ActionData<R> = R extends ActionFailure<infer F> ? F : R;
type FormOf<V> =
	ActionsType<V> extends Record<string, (c: never) => infer R>
		? ActionData<Awaited<R>> | null
		: null;

/** Path params: the `params` schema's output when present, else pattern-derived from the key. */
type ParamsOf<K extends string, V> =
	ParamsSchemaType<V> extends StandardSchemaV1 ? InferOutput<ParamsSchemaType<V>> : Params<K>;
/** Query params: the `search` schema's output when present, else `{}`. */
type SearchOf<V> =
	SearchSchemaType<V> extends StandardSchemaV1 ? InferOutput<SearchSchemaType<V>> : {};

/** Page entries: `{ [path]: { data, form, params, search } }` for every PageDef key. */
type PageEntries<T> = {
	[K in keyof T & string as T[K] extends AnyPageDef ? K : never]: T[K] extends AnyPageDef
		? {
				data: Simplify<PageData<T[K]>>;
				form: FormOf<T[K]>;
				params: Simplify<ParamsOf<K, T[K]>>;
				search: Simplify<SearchOf<T[K]>>;
			}
		: never;
};

/** Every prefix of a layout chain → `{ '(name)': { data: <prefix merge>, children } }`. `Acc` carries
 *  the ancestor data as we descend; each layout's entry is its ancestors ∧ its own load. */
type LayoutEntries<Ls extends readonly LayoutDef[], Acc = {}> = Ls extends readonly [
	infer H,
	...infer R
]
	? H extends LayoutDef<infer Name, unknown>
		? {
				[P in `(${Name})`]: { data: Simplify<Acc & LayoutData<H>>; children: Snippet };
			} & (R extends readonly LayoutDef[] ? LayoutEntries<R, Acc & LayoutData<H>> : {})
		: {}
	: {};

/** All layout entries across the table (a name repeats with the same prefix → intersection idempotent). */
type AllLayoutEntries<T> = UnionToIntersection<
	{ [K in keyof T]: T[K] extends AnyPageDef ? LayoutEntries<Layouts<T[K]>> : {} }[keyof T]
>;

// ── endpoint entries (the typed `api()` client's food) ───────────────────────────────────────────
/** A handler's PAYLOAD type: a PLAIN return is the JSON body (`finalize()` serializes it); a
 *  `Response` return erases to `unknown` (the payload type is inside the Response, unknowable). */
type PayloadOf<R> = [R] extends [never] ? unknown : R extends Response ? unknown : R;
type SlotOut<H> =
	H extends VerbEntry<infer O, unknown>
		? PayloadOf<O>
		: H extends (c: never) => infer R
			? PayloadOf<Awaited<R>>
			: unknown;
type SlotIn<H> = H extends VerbEntry<unknown, infer I> ? I : undefined;
type SlotEntry<H> = { out: SlotOut<H>; in: SlotIn<H> };

/** One endpoint's verb map, lowercase-keyed: `{ get: { out, in }, post: … }` — plus `params` from
 *  the table key. Pages never appear here (they carry `__ogkind`), so a key having `get`/`post`
 *  is what the `api()` client constrains on. */
type EndpointVerbs<V> = {
	[M in keyof V & string as V[M] extends undefined ? never : Lowercase<M>]: SlotEntry<V[M]>;
};
type EndpointEntries<T> = {
	[K in keyof T & string as T[K] extends AnyPageDef ? never : K]: T[K] extends AnyPageDef
		? never
		: Simplify<EndpointVerbs<T[K]> & { params: Simplify<Params<K>> }>;
};

/** The full `$infer` map: page paths ⊕ endpoint paths ⊕ layout `(name)`s. */
export type InferMap<T extends RouteTable> = Simplify<
	PageEntries<T> & EndpointEntries<T> & AllLayoutEntries<T>
>;
