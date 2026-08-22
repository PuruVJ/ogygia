/**
 * Parse the `ogygia({ content: { markdown } })` options out of a workspace `vite.config.ts`, so a REPL
 * user configures the markdown preview exactly as a real ogygia project does. Only the SAFE, in-browser
 * subset is applied (containers/tabs/heading-anchors/themes-by-name/diff+inline transformers); anything
 * that needs imports (a theme object, a custom transformer, loaders/router/regions) degrades to nothing
 * rather than misleading — the preset's vite.config comment says as much.
 *
 * The object literal is sandbox-evaluated with `with(proxy)`: the two named transformers resolve to the
 * real functions, every OTHER free identifier (an imported theme, `sveltekit`, …) resolves to an inert
 * stub, so the eval can't touch anything or throw on an unknown import.
 */
import { diff_markers, inline_markers } from 'ogygia/content/markdown';

/** The safe markdown options the REPL reads from a config (mirrors ogygia's MarkdownOptions subset). */
export interface ReplMarkdownConfig {
	containers?: boolean;
	tabs?: boolean;
	headingAnchors?: boolean;
	headingIds?: boolean;
	codeIds?: boolean;
	region?: boolean;
	overrides?: boolean | { tags?: string[] };
	themes?: { light?: string; dark?: string };
	defaultColor?: string;
	wrapperClass?: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	code?: { transformers?: any[] };
}

const SAFE_BOOL_KEYS = ['containers', 'tabs', 'headingAnchors', 'headingIds', 'codeIds', 'region'] as const;

/** Extract the FIRST `name(<object literal>)` call's object source (brace-balanced, string-aware). Returns
 *  the `{ … }` text or null. Doesn't parse comments/regex, but a config is clean enough — it fails to null. */
export function extract_call_object(src: string, name: string): string | null {
	const re = new RegExp('\\b' + name + '\\s*\\(');
	const m = re.exec(src);
	if (!m) return null;
	let i = m.index + m[0].length;
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] !== '{') return null;
	const start = i;
	let depth = 0;
	let str: string | null = null;
	for (; i < src.length; i++) {
		const c = src[i];
		if (str) {
			if (c === '\\') i++;
			else if (c === str) str = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') str = c;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return null;
}

/** Sanitize a raw evaluated markdown-options object down to the SAFE subset the REPL can honour. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitize(md: any): ReplMarkdownConfig {
	const out: ReplMarkdownConfig = {};
	for (const k of SAFE_BOOL_KEYS) if (typeof md[k] === 'boolean') out[k] = md[k];
	// overrides: boolean, or { tags: string[] }
	if (typeof md.overrides === 'boolean') out.overrides = md.overrides;
	else if (md.overrides && typeof md.overrides === 'object' && Array.isArray(md.overrides.tags))
		out.overrides = { tags: md.overrides.tags.filter((t: unknown) => typeof t === 'string') };
	// themes: string names only (a theme OBJECT came from an import → dropped, shiki falls back)
	if (md.themes && typeof md.themes === 'object') {
		const t: { light?: string; dark?: string } = {};
		if (typeof md.themes.light === 'string') t.light = md.themes.light;
		if (typeof md.themes.dark === 'string') t.dark = md.themes.dark;
		if (t.light || t.dark) out.themes = t;
	}
	if (typeof md.defaultColor === 'string') out.defaultColor = md.defaultColor;
	if (typeof md.wrapperClass === 'string') out.wrapperClass = md.wrapperClass;
	// transformers: keep only the ones that evaluated to a real object (the named ones); a stubbed custom
	// transformer came back as the inert stub function → dropped.
	if (md.code && Array.isArray(md.code.transformers)) {
		const real = md.code.transformers.filter((x: unknown) => x != null && typeof x === 'object' && !Array.isArray(x));
		if (real.length) out.code = { transformers: real };
	}
	return out;
}

/** Parse a `vite.config.*` source → the safe markdown config, or null (no ogygia call / unparseable). */
export function parse_config_markdown(configSrc: string): ReplMarkdownConfig | null {
	const objSrc = extract_call_object(configSrc, 'ogygia');
	if (!objSrc) return null;
	// One try/catch around EVAL *and* extraction/sanitize: a config can throw not just while evaluating
	// (a syntax error) but lazily on property access — a getter, a Proxy trap, a thrown value — and
	// sanitize reads those properties. Any of it → treat the config as absent (defaults), never crash.
	try {
		const stub = (): undefined => undefined;
		const helpers: Record<string, unknown> = {
			diff_markers, inline_markers, diffMarkers: diff_markers, inlineMarkers: inline_markers
		};
		const sandbox = new Proxy(helpers, {
			has: () => true, // trap EVERY free-variable lookup so an unknown import can't reach the real scope
			get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : stub)
		});
		// eslint-disable-next-line no-new-func
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const cfg: any = new Function('__S__', `with(__S__){ return (${objSrc}); }`)(sandbox);
		const md = cfg?.content?.markdown ?? cfg?.markdown;
		if (!md || typeof md !== 'object') return null;
		return sanitize(md);
	} catch {
		return null;
	}
}
