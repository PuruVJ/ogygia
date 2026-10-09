/**
 * Shared type helpers for `ogygia/router`: route-pattern params (derived from the pattern string) and
 * the Standard Schema interface used to gate endpoints. The value layer (the builder) lives in
 * builder.ts; this module is types only.
 */

// The Standard Schema interface (the `~standard` spec Zod / Valibot / ArkType all implement — the very
// thing Kit's remote functions consume). An endpoint's `get(schema, handler)` validates against this.
export interface StandardSchemaV1<Output = unknown> {
	readonly '~standard': {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
		readonly types?: { readonly output: Output };
	};
}
export type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardIssue> };
export interface StandardIssue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}
export type InferOutput<S> = S extends StandardSchemaV1<infer O> ? O : never;

/** Route params derived from the pattern string via template literals — `/docs/[slug]` → { slug: string },
 *  `/[[lang]]` → { lang?: string }, `/[...rest]` → { rest: string }, `/[id].json` → { id: string }. No codegen. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};
type SegParam<S extends string> = S extends `[[${infer O}]]`
	? { [K in O]?: string }
	: S extends `[...${infer R}]`
		? { [K in R]: string }
		: S extends `${string}[${infer N}]${string}`
			? { [K in N]: string }
			: {};
type ParamsAcc<P extends string> = P extends `${infer A}/${infer B}`
	? SegParam<A> & ParamsAcc<B>
	: SegParam<P>;
export type Params<P extends string> = Simplify<ParamsAcc<P>>;

/** The params object `href` accepts for a pattern — every param, as a string or number. */
export type HrefParams<P extends string> = { [K in keyof Params<P>]: string | number };
/** href args: params are REQUIRED when the pattern has any, omittable when it has none. */
export type HrefArgs<P extends string> =
	{} extends Params<P> ? [params?: HrefParams<P>] : [params: HrefParams<P>];
