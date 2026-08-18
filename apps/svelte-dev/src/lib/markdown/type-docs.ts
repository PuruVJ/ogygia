/**
 * Type-docs generator — the data half of svelte.dev's `> MODULE:` / `> TYPES:` directives.
 *
 * svelte.dev's sync script bakes reference pages from the packages' generated `.d.ts`; we do the
 * same at compile time, straight from the INSTALLED packages (dts-buddy single-file types:
 * `node_modules/svelte/types/index.d.ts`, `node_modules/@sveltejs/kit/types/index.d.ts`). For a
 * module it emits svelte.dev's markup shape: an import-summary fence, then per-export `## Name`
 * sections — since-note, JSDoc prose (markdown flows through), and a `ts-block` signature (classes /
 * interfaces get the elided header + per-member `ts-block-property` breakdown).
 *
 * Node-only (runs inside the remark expansion pass at compile time); TypeScript loads lazily.
 */
import fs from 'node:fs';
import path from 'node:path';

type TS = typeof import('typescript');

let ts: TS | null = null;
async function load_ts(): Promise<TS> {
	if (!ts) {
		const m = await import('typescript');
		ts = (m as { default?: TS }).default ?? (m as unknown as TS);
	}
	return ts;
}

/** Which package's .d.ts declares a module id. */
function dts_path_for(module_id: string): string | null {
	const pkg = module_id.startsWith('svelte')
		? 'svelte'
		: /^(@sveltejs\/kit|\$app|\$service-worker|\$env)/.test(module_id)
			? '@sveltejs/kit'
			: null;
	if (!pkg) return null;
	const p = path.join(process.cwd(), 'node_modules', pkg, 'types', 'index.d.ts');
	return fs.existsSync(p) ? p : null;
}

// One parse per .d.ts per process.
const sources = new Map<string, import('typescript').SourceFile>();
async function source_file(file: string) {
	let sf = sources.get(file);
	if (!sf) {
		const t = await load_ts();
		sf = t.createSourceFile(file, fs.readFileSync(file, 'utf8'), t.ScriptTarget.Latest, true);
		sources.set(file, sf);
	}
	return sf;
}

type Export = {
	name: string;
	/** Full declaration text (no JSDoc). */
	text: string;
	/** JSDoc prose (markdown), '' if none. */
	doc: string;
	since?: string;
	deprecated?: string;
	kind: 'class' | 'interface' | 'function' | 'const' | 'type' | 'other';
	members: Array<{ text: string; doc: string }>;
};

function jsdoc_of(t: TS, node: import('typescript').Node): { doc: string; since?: string; deprecated?: string } {
	const jd = (node as { jsDoc?: Array<import('typescript').JSDoc> }).jsDoc;
	const j = jd?.[jd.length - 1];
	if (!j) return { doc: '' };
	const doc = (t.getTextOfJSDocComment(j.comment) ?? '').trim();
	let since: string | undefined;
	let deprecated: string | undefined;
	for (const tag of j.tags ?? []) {
		const name = tag.tagName.text;
		if (name === 'since') since = (t.getTextOfJSDocComment(tag.comment) ?? '').trim();
		if (name === 'deprecated') deprecated = (t.getTextOfJSDocComment(tag.comment) ?? '').trim() || 'deprecated';
	}
	return { doc, since, deprecated };
}

function is_exported(t: TS, node: import('typescript').Node): boolean {
	const mods = (node as { modifiers?: ReadonlyArray<import('typescript').ModifierLike> }).modifiers;
	return !!mods?.some((m) => m.kind === t.SyntaxKind.ExportKeyword);
}

/** Collect the exported declarations of one `declare module 'id'` block (or a namespace body). */
function collect_exports(
	t: TS,
	sf: import('typescript').SourceFile,
	body: import('typescript').Node,
	all = false
): Export[] {
	const out: Export[] = [];
	const push = (node: import('typescript').Node, name: string, kind: Export['kind'], members: Export['members'] = []) => {
		const meta = jsdoc_of(t, node);
		out.push({ name, kind, members, text: sf.text.slice(node.getStart(sf), node.end), ...meta });
	};
	t.forEachChild(body, (node) => {
		if (!all && !is_exported(t, node)) return;
		if (t.isClassDeclaration(node) && node.name) {
			push(node, node.name.text, 'class', members_of(t, sf, node.members));
		} else if (t.isInterfaceDeclaration(node)) {
			push(node, node.name.text, 'interface', members_of(t, sf, node.members));
		} else if (t.isFunctionDeclaration(node) && node.name) {
			// overloads: merge into the first occurrence's members list as extra signatures
			const prev = out.find((e) => e.name === node.name!.text);
			if (prev) prev.members.push({ text: sf.text.slice(node.getStart(sf), node.end), doc: '' });
			else push(node, node.name.text, 'function');
		} else if (t.isVariableStatement(node)) {
			for (const d of node.declarationList.declarations) {
				if (t.isIdentifier(d.name)) push(node, d.name.text, 'const');
			}
		} else if (t.isTypeAliasDeclaration(node)) {
			push(node, node.name.text, 'type');
		} else if (t.isEnumDeclaration(node)) {
			push(node, node.name.text, 'other');
		}
	});
	return out;
}

function members_of(
	t: TS,
	sf: import('typescript').SourceFile,
	members: ReadonlyArray<import('typescript').Node>
): Export['members'] {
	const out: Export['members'] = [];
	for (const m of members) {
		// skip private/internal members
		const mods = (m as { modifiers?: ReadonlyArray<import('typescript').ModifierLike> }).modifiers;
		if (mods?.some((x) => x.kind === t.SyntaxKind.PrivateKeyword)) continue;
		const name = (m as { name?: import('typescript').Node }).name;
		if (name && t.isPrivateIdentifier(name as never)) continue;
		const { doc } = jsdoc_of(t, m);
		if (doc.includes('@internal')) continue;
		out.push({ text: sf.text.slice(m.getStart(sf), m.end), doc });
	}
	return out;
}

const fence = (code: string) => '```ts\n' + code + '\n```';

/**
 * JSDoc prose flows into mdsvex → the SVELTE parser. A bare `<svelte:boundary>`-style sequence in
 * PLAIN text would parse as an inline-HTML node and reach Svelte as a real tag — escape those to
 * `\<` so fromMarkdown reads them as text. Inline code spans and fences pass verbatim here; their
 * `<`/`{` content is entity-escaped at the TREE level in expand-types (mdsvex's serializer emits
 * text/inline-code values verbatim, so string-level entities would just be decoded and lost).
 */
function sanitize_doc(doc: string): string {
	return doc
		.split(/(```[\s\S]*?```)/g)
		.map((seg, i) =>
			i % 2
				? seg
				: seg
						.split(/(`[^`\n]*`)/g)
						.map((s, j) => (j % 2 ? s : s.replace(/<(?=[A-Za-z/!])/g, '\\<')))
						.join('')
		)
		.join('');
}

/** One export → its markdown section (svelte.dev's shape). */
function render_export(e: Export): string {
	const parts: string[] = [`## ${e.name}`, ''];
	if (e.since) parts.push(`<blockquote class="since note">\n\nAvailable since ${e.since}\n\n</blockquote>`, '');
	if (e.deprecated) parts.push(`<blockquote class="deprecated">\n\n${sanitize_doc(e.deprecated)}\n\n</blockquote>`, '');
	if (e.doc) parts.push(sanitize_doc(e.doc), '');

	if ((e.kind === 'class' || e.kind === 'interface') && e.members.length) {
		// elided header + per-member property blocks
		const header = e.text.replace(/\{[\s\S]*\}$/, '{/*…*/}');
		parts.push('<div class="ts-block">', '', fence(header), '');
		for (const m of e.members) {
			parts.push('<div class="ts-block-property">', '', fence(m.text), '');
			if (m.doc) parts.push('<div class="ts-block-property-details">', '', sanitize_doc(m.doc), '', '</div>', '');
			parts.push('</div>', '');
		}
		parts.push('</div>', '');
	} else if (e.kind === 'function' && e.members.length) {
		// merged overloads
		parts.push('<div class="ts-block">', '', fence([e.text, ...e.members.map((m) => m.text)].join('\n')), '', '</div>', '');
	} else {
		parts.push('<div class="ts-block">', '', fence(e.text), '', '</div>', '');
	}
	return parts.join('\n');
}

/** `> MODULE: id` → the whole module reference (import summary + per-export sections). */
export async function render_module(module_id: string): Promise<string | null> {
	const file = dts_path_for(module_id);
	if (!file) return null;
	const t = await load_ts();
	const sf = await source_file(file);
	let body: import('typescript').Node | null = null;
	t.forEachChild(sf, (node) => {
		if (
			t.isModuleDeclaration(node) &&
			t.isStringLiteral(node.name) &&
			node.name.text === module_id &&
			node.body
		) {
			body = node.body;
		}
	});
	if (!body) return null;
	const exports = collect_exports(t, sf, body);
	if (!exports.length) return null;

	const names = exports.map((e) => e.name).sort((a, b) => a.localeCompare(b));
	const summary = '```js\nimport {\n\t' + names.join(',\n\t') + "\n} from '" + module_id + "';\n```";
	return [summary, '', ...exports.map(render_export)].join('\n');
}

/**
 * `> TYPES: title` / `> TYPES: title#Export` → sections for kit's shared/ambient types.
 * `App` resolves the ambient `namespace App`; `X#Y` renders the single export `Y` of '@sveltejs/kit'.
 */
export async function render_types(directive: string): Promise<string | null> {
	const file = dts_path_for('@sveltejs/kit');
	if (!file) return null;
	const t = await load_ts();
	const sf = await source_file(file);

	const hash = directive.indexOf('#');
	const pick = hash > -1 ? directive.slice(hash + 1).trim() : null;

	if (directive === 'App') {
		// ambient `declare global { namespace App { … } }` or top-level `declare namespace App`
		let body: import('typescript').Node | null = null;
		const visit = (node: import('typescript').Node) => {
			if (t.isModuleDeclaration(node) && t.isIdentifier(node.name) && node.name.text === 'App' && node.body) {
				body = node.body;
			}
			t.forEachChild(node, visit);
		};
		visit(sf);
		if (!body) return null;
		const exports = collect_exports(t, sf, body, true);
		return exports.length ? exports.map(render_export).join('\n') : null;
	}

	// pick one (or all) exported declarations of '@sveltejs/kit'
	let mod: import('typescript').Node | null = null;
	t.forEachChild(sf, (node) => {
		if (t.isModuleDeclaration(node) && t.isStringLiteral(node.name) && node.name.text === '@sveltejs/kit' && node.body) {
			mod = node.body;
		}
	});
	if (!mod) return null;
	const exports = collect_exports(t, sf, mod);
	const chosen = pick ? exports.filter((e) => e.name === pick) : exports;
	return chosen.length ? chosen.map(render_export).join('\n') : null;
}
