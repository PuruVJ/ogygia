/**
 * Shared type helpers for `@ogygia/router`: route-pattern params (derived from the pattern string) and
 * the Standard Schema interface used to gate endpoints (core's: `ogygia/plugin/utils`). The value layer
 * lives in define.ts; this module is types only.
 */
import type { StandardSchemaV1 } from 'ogygia/plugin/utils';

// An endpoint's `GET(schema, handler)` validates against the Standard Schema interface (the `~standard`
// spec Zod / Valibot / ArkType all implement — the very thing Kit's remote functions consume).
export type { StandardSchemaV1, StandardResult, StandardIssue } from 'ogygia/plugin/utils';
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
