/**
 * API-reference extraction — the data half of the docs' `> MODULE: ogygia/…` directive.
 *
 * Reads the PUBLIC surface of an ogygia entry point straight from the package's built, rolled-up
 * `dist/*.d.ts` (resolved through the export map's `types` condition), via the TypeScript compiler
 * API — so the reference regenerates from source on every build (`build:lib` always precedes the
 * docs build/dev in the root scripts) and documents exactly the types that ship. Node-only: runs
 * inside the remark expansion pass at compile time; TypeScript loads lazily.
 *
 * Freshness is watertight through two hooks the markdown pipeline exposes for generator plugins:
 * `cache_key` (an mtime hash of the whole d.ts set — a JSDoc edit re-keys every doc cache entry
 * that could have expanded it) and `dependencies` (the files each page actually read — Vite
 * recompiles the page in dev when they change).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

type TS = typeof import('typescript');
let ts_mod: TS | null = null;
async function loadTs(): Promise<TS> {
	if (!ts_mod) {
		const m = await import('typescript');
		ts_mod = (m as { default?: TS }).default ?? (m as unknown as TS);
	}
	return ts_mod;
}

const require_ = createRequire(import.meta.url);

/** The ogygia package root — resolve the entry (the export map hides `./package.json`), walk up. */
let pkg_root: string | null = null;
export function packageRoot(): string {
	if (pkg_root) return pkg_root;
	let dir = path.dirname(require_.resolve('ogygia'));
	for (let i = 0; i < 6; i++) {
		const pj = path.join(dir, 'package.json');
		if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'ogygia') {
			return (pkg_root = dir);
		}
		dir = path.dirname(dir);
	}
	throw new Error('[api-ref] could not locate the ogygia package root.');
}

/** Module id (`ogygia/content`) → the export map's `types` file, absolute. */
export function dtsPathFor(moduleId: string): string | null {
	const root = packageRoot();
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
		exports?: Record<string, { types?: string } | string>;
	};
	const sub = moduleId === 'ogygia' ? '.' : './' + moduleId.replace(/^ogygia\//, '');
	const entry = pkg.exports?.[sub];
	const types = typeof entry === 'object' && entry?.types ? entry.types : null;
	if (!types) return null;
	const abs = path.join(root, types);
	return fs.existsSync(abs) ? abs : null;
}

export type ApiMember = { name: string; text: string; doc: string };
export type ApiExport = {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'component' | 'other';
	/** Declaration text (JSDoc stripped; overloads joined). For interface/class: the header line. */
	text: string;
	/** JSDoc prose — markdown, verbatim (the house style writes real markdown with fences). */
	doc: string;
	params: Array<{ name: string; doc: string }>;
	examples: string[];
	returns?: string;
	deprecated?: string;
	/** Interface / class members, each with its own signature + prose. */
	members: ApiMember[];
};

export type ApiModule = { id: string; exports: ApiExport[]; files: string[] };

// One extraction per entry per process, invalidated by the d.ts mtime hash (dev edits d.ts via
// build:lib; a changed hash re-extracts on the next page compile).
const memo = new Map<string, { key: string; mod: ApiModule }>();

/** mtime+size hash over the package's dist d.ts set — the generator's whole input space. */
export function distStamp(): string {
	const dist = path.join(packageRoot(), 'dist');
	let h = 2166136261;
	const mix = (s: string) => {
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
	};
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.d.ts')) {
				const st = fs.statSync(p);
				mix(`${p}:${st.mtimeMs}:${st.size}`);
			}
		}
	};
	walk(dist);
	return (h >>> 0).toString(36);
}

/** TTL-memoized stamp — doc_sig reads it once per document compile; keep the stat sweep off the hot path. */
let stamp_at = 0;
let stamp_val = '';
export function distStampCached(): string {
	const now = Date.now();
	if (now - stamp_at > 1500) {
		stamp_val = distStamp();
		stamp_at = now;
	}
	return stamp_val;
}

function stripDeclare(text: string): string {
	return text
		.replace(/^export\s+declare\s+/, '')
		.replace(/^declare\s+/, '')
		.replace(/^export\s+/, '');
}

/** Drop JSDoc blocks from a declaration's text (members carry their prose separately). */
function stripJsdoc(text: string): string {
	return text
		.replace(/^[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*\r?\n/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export async function extractModule(moduleId: string): Promise<ApiModule> {
	const entry = dtsPathFor(moduleId);
	if (!entry) throw new Error(`[api-ref] no types entry for '${moduleId}' in ogygia's export map.`);
	const key = distStamp();
	const hit = memo.get(moduleId);
	if (hit && hit.key === key) return hit.mod;

	const ts = await loadTs();
	const program = ts.createProgram([entry], {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowArbitraryExtensions: true, // resolves `./Region.svelte` → `Region.svelte.d.ts`
		skipLibCheck: true,
		noEmit: true
	});
	const checker = program.getTypeChecker();
	const sf = program.getSourceFile(entry);
	if (!sf) throw new Error(`[api-ref] could not load ${entry}`);
	const module_symbol = checker.getSymbolAtLocation(sf);
	if (!module_symbol) throw new Error(`[api-ref] ${entry} has no module symbol (no exports?)`);

	const out: ApiExport[] = [];
	for (const raw of checker.getExportsOfModule(module_symbol)) {
		const symbol = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
		const decls = symbol.declarations ?? [];
		const decl = decls[0];
		if (!decl) continue;
		const decl_file = decl.getSourceFile().fileName;

		const kind: ApiExport['kind'] = decl_file.endsWith('.svelte.d.ts')
			? 'component'
			: ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)
				? 'function'
				: ts.isClassDeclaration(decl)
					? 'class'
					: ts.isInterfaceDeclaration(decl)
						? 'interface'
						: ts.isTypeAliasDeclaration(decl)
							? 'type'
							: ts.isVariableDeclaration(decl)
								? typeof checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures?.()?.length ===
											'number' &&
									  checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures().length > 0
									? 'function'
									: 'const'
								: 'other';

		// Signature text: functions join their overloads; containers keep the header line only
		// (members get their own breakdown); everything else prints whole.
		let text: string;
		let members: ApiMember[] = [];
		if (ts.isInterfaceDeclaration(decl) || ts.isClassDeclaration(decl)) {
			const full = stripDeclare(decl.getText());
			text = full.slice(0, full.indexOf('{')).trim() + ' {/*…*/}';
			const container = decl as import('typescript').InterfaceDeclaration;
			for (const m of container.members) {
				const name = (m.name && ts.isIdentifier(m.name) ? m.name.text : m.name?.getText()) ?? '';
				if (!name || name.startsWith('__') || name.startsWith('#')) continue;
				const msym = (m as unknown as { symbol?: import('typescript').Symbol }).symbol;
				const mdoc = msym ? ts.displayPartsToString(msym.getDocumentationComment(checker)) : '';
				members.push({ name, text: stripJsdoc(stripDeclare(m.getText())), doc: mdoc });
			}
		} else if (kind === 'function') {
			text = decls
				.filter((d) => ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d))
				.map((d) =>
					ts.isVariableDeclaration(d)
						? `const ${stripJsdoc(stripDeclare(d.getText()))}`
						: stripJsdoc(stripDeclare(d.getText()))
				)
				.join('\n');
		} else if (kind === 'component') {
			text = `import ${symbol.name} from '${moduleId}';`;
		} else if (ts.isVariableDeclaration(decl)) {
			text = `const ${stripJsdoc(stripDeclare(decl.getText()))}`;
		} else {
			text = stripJsdoc(stripDeclare(decl.getText()));
		}

		const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker));
		const tags = symbol.getJsDocTags(checker);
		const tag_text = (t: { text?: readonly { text: string }[] }) =>
			(t.text ?? []).map((p) => p.text).join('');
		const params = tags
			.filter((t) => t.name === 'param')
			.map((t) => {
				const whole = tag_text(t);
				const m = /^(\S+)\s*(?:—|-)?\s*([\s\S]*)$/.exec(whole.trim());
				return { name: m?.[1] ?? '', doc: (m?.[2] ?? '').trim() };
			})
			.filter((p) => p.name && p.doc);
		const examples = tags.filter((t) => t.name === 'example').map((t) => tag_text(t).trim());
		const returns = tags.find((t) => t.name === 'returns');
		const deprecated = tags.find((t) => t.name === 'deprecated');

		out.push({
			name: symbol.name,
			kind,
			text,
			doc,
			params,
			examples,
			returns: returns ? tag_text(returns).trim() : undefined,
			deprecated: deprecated ? tag_text(deprecated).trim() || 'Deprecated.' : undefined,
			members
		});
	}

	// Values first (functions/components/classes/consts), then types — reference reads best that way.
	const rank = { function: 0, component: 1, class: 2, const: 3, interface: 4, type: 5, other: 6 };
	out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));

	const files = program
		.getSourceFiles()
		.map((f) => f.fileName)
		.filter((f) => f.includes('/ogygia/dist/'));

	const mod: ApiModule = { id: moduleId, exports: out, files };
	memo.set(moduleId, { key, mod });
	return mod;
}
