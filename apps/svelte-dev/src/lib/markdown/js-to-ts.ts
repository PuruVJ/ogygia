/**
 * Blessed fence adapters — importable VALUES for the code pipeline's `variants` slot. Heavy deps
 * (the TypeScript compiler, MagicString) load lazily so importing this costs nothing unless a
 * generator fires.
 *
 * The JS→TS converter is a full port of @sveltejs/site-kit's `convert_to_ts` (MIT — the exact code
 * svelte.dev runs over this same corpus), adapted to ogygia's fence contract: JSDoc `@type` /
 * `@param` / `@returns` / `@satisfies` become real annotations, `@type` on a function declaration
 * rewrites it to a typed `const`, `import('./$types').X` types collect into `import type`
 * statements, and casts become `as`.
 */
import type { Fence, Variant, VariantGenerator } from 'ogygia/content/markdown';
import type TS from 'typescript';
import type MagicStringT from 'magic-string';

/** The preference the JS↔TS switcher binds to (author JS, DEFAULT to TS — svelte.dev's choice). */
const CODE_LANGUAGE = { name: 'code-language', values: ['ts', 'js'] as const, default: 'ts' };

type Deps = { ts: typeof TS; MagicString: typeof MagicStringT };

/**
 * JS↔TS variants: author ONE fence in JavaScript with JSDoc annotations; this generates the
 * TypeScript version via the TypeScript compiler API. Fires on `js` / `svelte` fences; a `js` fence
 * with nothing to convert stays single-language, while every plain-script `svelte` fence gets at
 * minimum a `lang="ts"` variant (svelte.dev's rule — their Overview fence shows the toggle with no
 * JSDoc at all). A snippet with an UNHANDLED JSDoc shape throws a named build error, never silently
 * degrades — same policy as site-kit.
 *
 * Sync `generate()` returns the JS variant immediately and fills the TS variant once the deps have
 * loaded (the pipeline awaits the module's `ready` before rendering). `cache_key` folds the TS
 * version into the fence cache so a compiler bump re-generates.
 */
export function js_to_ts(): VariantGenerator {
	let deps: Deps | null = null;
	let ready: Promise<void> | null = null;
	const load = () =>
		(ready ??= Promise.all([import('typescript'), import('magic-string')]).then(([t, m]) => {
			deps = {
				ts: (t as { default?: typeof TS }).default ?? (t as unknown as typeof TS),
				MagicString: (m as { default: typeof MagicStringT }).default
			};
		}));

	return {
		pref: CODE_LANGUAGE,
		get cache_key() {
			// `#5`: svelte script splice re-adds the newlines the converter strips (Overview glue bug).
			return deps ? `ts@${deps.ts.version}#5` : 'ts#5';
		},
		ready: () => load(),
		generate(fence: Fence): Variant[] | null {
			if (fence.lang !== 'js' && fence.lang !== 'svelte') return null;
			if (!deps) return [{ label: 'JS', value: 'js', fence }]; // deps not loaded yet — JS only
			const converted = convert(deps, fence.source, fence.lang);
			if (converted == null) return [{ label: 'JS', value: 'js', fence }]; // nothing to convert → single
			return [
				{ label: 'TS', value: 'ts', fence: { ...fence, lang: fence.lang === 'svelte' ? 'svelte' : 'ts', source: converted } },
				{ label: 'JS', value: 'js', fence }
			];
		}
	};
}

/** Svelte fences: convert only the instance `<script>` (site-kit's assumption: no module blocks) and
 *  re-lang it. Every plain-script fence converts — at minimum gaining `lang="ts"`. */
function convert(deps: Deps, source: string, lang: string): string | null {
	if (lang === 'svelte') {
		const m = /(<script[^>]*>)([\s\S]*?)(<\/script>)/.exec(source);
		if (!m) return null;
		if (m[1]!.includes('lang=')) return null; // already TS-authored — nothing to offer
		// site-kit shape: the converter strips the inner's leading/trailing newlines, the CALLER adds
		// exactly one back on each side — `<script lang="ts">\n…\n</script>`. Splicing the converter's
		// stripped output directly would glue the code onto the tags (the Overview formatting bug).
		const converted = convert_to_ts(deps, m[2]!, '\t', '\n');
		const inner = converted == null ? m[2]! : `\n${converted}\n`;
		const open = m[1]!.replace('<script', '<script lang="ts"');
		return source.slice(0, m.index) + open + inner + m[3]! + source.slice(m.index + m[0]!.length);
	}
	return convert_to_ts(deps, source);
}

/**
 * Transforms a JS code block into a TS code block by turning JSDoc into type annotations.
 * Due to pragmatism only the cases currently used in the docs are implemented.
 * (site-kit `convert_to_ts`, ported verbatim minus `await` — nothing inside was async.)
 */
function convert_to_ts(deps: Deps, js_code: string, indent = '', offset = ''): string | null {
	const { ts, MagicString } = deps;

	js_code = js_code
		.replaceAll('// @filename: index.js', '// @filename: index.ts')
		.replace(/(\/\/\/ .+?\.)js/, '$1ts')
		// *\/ appears in some JsDoc comments in d.ts files due to the JSDoc-in-JSDoc problem
		.replace(/\*\\\//g, '*/');

	const ast = ts.createSourceFile('filename.ts', js_code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const code = new MagicString(js_code);
	const imports = new Map<string, Set<string>>();

	function get_jsdoc(node: TS.Node) {
		const { jsDoc } = node as { jsDoc?: TS.JSDoc[] };
		return jsDoc;
	}

	function walk(node: TS.Node, prev: TS.Node | null) {
		const jsdoc = get_jsdoc(node);
		if (jsdoc) {
			// this isn't an exhaustive list of tags we could potentially encounter (no `@template` etc)
			// but it's good enough to cover what's actually in the docs right now
			let type: string | null = null;
			const params: string[] = [];
			let returns: string | null = null;
			let satisfies: string | null = null;

			if (jsdoc.length > 1) {
				throw new Error('woah nelly');
			}

			const { comment, tags = [] } = jsdoc[0]!;

			for (const tag of tags) {
				if (ts.isJSDocTypeTag(tag)) {
					type = get_type_info(get_jsdoc_type_expression_text(tag.getText()));
				} else if (ts.isJSDocParameterTag(tag)) {
					params.push(get_type_info(tag.typeExpression?.getText()!));
				} else if (ts.isJSDocReturnTag(tag)) {
					returns = get_type_info(tag.typeExpression?.getText()!);
				} else if (ts.isJSDocSatisfiesTag(tag)) {
					satisfies = get_type_info(tag.typeExpression?.getText()!);
				} else {
					throw new Error('Unhandled tag: ' + tag.getText());
				}

				let start = tag.getStart();
				let end = tag.getEnd();

				while (start > 0 && code.original[start] !== '\n') start -= 1;
				while (end > 0 && code.original[end] !== '\n') end -= 1;
				code.remove(start, end);
			}

			if (type && satisfies) {
				throw new Error('Cannot combine @type and @satisfies');
			}

			if (ts.isFunctionDeclaration(node)) {
				// convert function to a `const`
				if (type || satisfies) {
					const is_export = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
					const is_async = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

					code.overwrite(node.getStart(), node.name!.getStart(), is_export ? `export const ` : `const `);

					const modifier = is_async ? 'async ' : '';
					code.appendLeft(node.name!.getEnd(), type ? `: ${type} = ${modifier}` : ` = ${modifier}(`);

					code.prependRight(node.body!.getStart(), '=> ');

					code.appendLeft(node.getEnd(), satisfies ? `) satisfies ${satisfies};` : ';');
				}

				for (let i = 0; i < node.parameters.length; i += 1) {
					if (params[i] !== undefined) {
						code.appendLeft(node.parameters[i]!.getEnd(), `: ${params[i]}`);
					}
				}

				if (returns) {
					let start = node.body!.getStart();
					while (code.original[start - 1] !== ')') start -= 1;
					code.appendLeft(start, `: ${returns}`);
				}
			} else if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
				if (params.length > 0 || returns) {
					throw new Error('TODO handle @params and @returns in variable declarations');
				}

				const declaration = node.declarationList.declarations[0]!;

				if (type) {
					code.appendLeft(declaration.name.getEnd(), `: ${type}`);
				}

				if (satisfies) {
					let end = declaration.getEnd();
					if (code.original[end - 1] === ';') end -= 1;
					code.appendLeft(end, ` satisfies ${satisfies}`);
				}
			} else if (
				(ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)) ||
				ts.isMethodDeclaration(node)
			) {
				if (type) {
					throw new Error('@type on property methods does nothing');
				}

				const parameters = ts.isMethodDeclaration(node)
					? node.parameters
					: (node.initializer as TS.ArrowFunction).parameters;
				for (let i = 0; i < parameters.length; i += 1) {
					if (params[i] !== undefined) {
						code.appendLeft(parameters[i]!.getEnd(), `: ${params[i]}`);
					}
				}

				if (returns) {
					const body = ts.isMethodDeclaration(node) ? node.body : (node.initializer as TS.ArrowFunction).body;
					let start = body!.getStart();
					while (code.original[start - 1] !== ')') start -= 1;
					code.appendLeft(start, `: ${returns}`);
				}
			} else if (type && ts.isParenthesizedExpression(node)) {
				// convert `/* @type {Foo} */ (foo)` to `foo as Foo`
				// TODO one day we may need to account for operator precedence
				// (i.e. preserve the parens in e.g. `(x as y).z()`)
				let start = node.getStart();
				while (js_code[start - 1] !== '/') start -= 1;
				code.remove(start, node.getStart() + 1);

				const end = node.getEnd();
				code.overwrite(end - 1, end, ` as ${type}`);
			} else {
				throw new Error('Unhandled @type JsDoc->TS conversion: ' + js_code.slice(node.getStart(), node.getEnd()));
			}

			if (!comment) {
				// remove the whole thing
				let start = jsdoc[0]!.getStart();
				const end = jsdoc[0]!.getEnd();

				while (start > 0 && code.original[start - 1] === '\t') start -= 1;
				while (start > 0 && code.original[start - 1] === '\n') start -= 1;

				let is_multiline = false;

				if (prev) {
					is_multiline =
						code.original.slice(prev.getStart(), prev.getEnd()).includes('\n') ||
						code.original.slice(node.getStart(), node.getEnd()).includes('\n');
				}

				code.overwrite(start, end, is_multiline ? '\n' : '');
			}
		}

		// the TypeScript API is such a hot mess, AFAICT there is no non-stupid way
		// to get the previous sibling within the visitor, so since we need it we
		// have to pass it in from the parent visitor
		let child_prev: TS.Node | null = null;

		for (const child_node of node.getChildren()) {
			walk(child_node, child_prev);
			child_prev = child_node;
		}
	}

	walk(ast, null);

	if (imports.size) {
		const import_statements = Array.from(imports.entries())
			.map(([from, names]) => {
				return `${indent}import type { ${Array.from(names).join(', ')} } from '${from}';`;
			})
			.join('\n');

		const last_import = [...ast.statements].findLast((statement) => ts.isImportDeclaration(statement));

		if (last_import) {
			code.appendLeft(last_import.getEnd(), '\n' + import_statements);
		} else {
			code.prependLeft(0, offset + import_statements + '\n');
		}
	}

	// remove leading/trailing newlines (not any whitespace, because that can signify diffs)
	const transformed = code.toString().replace(/^\n+/, '').replace(/\n+$/, '');

	return transformed === js_code ? null : transformed;

	function get_type_info(text: string) {
		const type = text
			.replace(/^\{|\}$/g, '') // remove surrounding `{` and `}`
			.replace(/ \* ?/gm, '')
			.replace(/import\('(.+?)'\)\.(\w+)(?:(<.+>))?/gms, (_, source: string, name: string, args = '') => {
				const existing = imports.get(source);
				if (existing) {
					existing.add(name);
				} else {
					imports.set(source, new Set([name]));
				}

				return name + args;
			});

		return type;
	}

	function get_jsdoc_type_expression_text(text: string): string {
		return text.replace(/^@type\s*/, '').trim();
	}
}
