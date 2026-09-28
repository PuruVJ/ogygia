/**
 * Turn a TypeScript Svelte component into a plain-JS one, for shipping raw.
 *
 * `preprocess()` transpiles the `<script>`, but never the template: a `{x as Y}`, `{a!.b}` or
 * `{#snippet row(l: Line)}` survives it, and once `lang="ts"` is gone the consumer's compiler reads
 * it as broken JS. `strip_markup_ts` takes Svelte's own parse of the file (which reads the template
 * as TS while `lang="ts"` is still on the script) and cuts every type-only span out of the
 * template's expressions: `as` / `satisfies` casts, `!` assertions, annotations, generic
 * arguments. Only type-only syntax exists in a Svelte template, so the cuts leave exactly the JS.
 * It also drops the `lang="ts"` attribute from each script, by the parse, not by pattern.
 *
 * Run it on the output of `preprocess()`: the script is JS by then and the markup still TS.
 */
import MagicString from 'magic-string';
import { parse } from 'svelte/compiler';

interface Span {
	type?: string;
	start: number;
	end: number;
	[k: string]: unknown;
}

interface Attr extends Span {
	name: string;
	value: unknown;
}

interface Root {
	fragment: unknown;
	instance?: { attributes: Attr[] } | null;
	module?: { attributes: Attr[] } | null;
}

const is_node = (v: unknown): v is Span =>
	!!v && typeof v === 'object' && typeof (v as Span).start === 'number' && typeof (v as Span).end === 'number';

/** keys that hold a type, never a value: cut the whole span and do not look inside */
const TYPE_KEYS: ReadonlySet<string> = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType']);

/** the static text of an attribute value (`lang="ts"` → `ts`), or undefined */
function attr_text(a: Attr): string | undefined {
	const v = a.value;
	if (!Array.isArray(v) || v.length !== 1) return undefined;
	const t = v[0] as { type?: string; data?: string };
	return t.type === 'Text' ? t.data : undefined;
}

/** true when the source has a `<script lang="ts">`: a cheap check before paying for a parse */
const has_ts_script = (source: string) => source.includes('lang="ts"') || source.includes("lang='ts'");

export function strip_markup_ts(source: string, filename?: string): string {
	if (!has_ts_script(source)) return source;
	const ast = parse(source, { modern: true, filename }) as unknown as Root;
	const s = new MagicString(source);
	const seen = new Set<unknown>();

	const visit = (v: unknown): void => {
		if (!v || typeof v !== 'object' || seen.has(v)) return;
		seen.add(v);
		if (Array.isArray(v)) {
			for (const x of v) visit(x);
			return;
		}
		const n = v as Span;
		// `x as T`, `x satisfies T`, `x!`: keep the expression, drop the rest of the node
		if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression') {
			const inner = n.expression as Span;
			if (inner.end < n.end) s.remove(inner.end, n.end);
			visit(inner);
			return;
		}
		// `<T>x`: drop the leading assertion
		if (n.type === 'TSTypeAssertion') {
			const inner = n.expression as Span;
			if (n.start < inner.start) s.remove(n.start, inner.start);
			visit(inner);
			return;
		}
		for (const k in n) {
			if (k === 'parent' || k === 'metadata') continue;
			const c = n[k];
			if (TYPE_KEYS.has(k)) {
				if (is_node(c) && c.start < c.end) s.remove(c.start, c.end);
				continue;
			}
			visit(c);
		}
	};
	// the template only: the script is already JS (preprocessed), and the style is CSS
	visit(ast.fragment);

	// drop `lang="ts"` (with the space before it) from each script tag
	for (const script of [ast.instance, ast.module]) {
		for (const a of script?.attributes ?? []) {
			if (a.name !== 'lang' || attr_text(a) !== 'ts') continue;
			let from = a.start;
			while (from > 0 && (source[from - 1] === ' ' || source[from - 1] === '\t' || source[from - 1] === '\n')) from--;
			s.remove(from, a.end);
		}
	}
	return s.hasChanged() ? s.toString() : source;
}
