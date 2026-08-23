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

/** Every markdown option the in-browser preview can honour. Anything else in `content.markdown` is
 *  reported (not silently dropped) so the user knows what to change. */
const ALLOWED_MARKDOWN_KEYS = [
	...SAFE_BOOL_KEYS,
	'overrides',
	'themes',
	'defaultColor',
	'wrapperClass',
	'code'
] as const;
const ALLOWED_MARKDOWN_LIST = ALLOWED_MARKDOWN_KEYS.join(', ');

/** A deliberate, human-readable note about a config option the preview can't apply — surfaced in the
 *  UI so the user isn't left guessing why an edit did nothing. `hint` says what's allowed / to change. */
export interface ConfigNote {
	level: 'error' | 'warn' | 'info';
	message: string;
	hint?: string;
}

/** A plain-English type label for a rejected value ("a string", "an object", …). */
function type_label(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'an array';
	const t = typeof v;
	return t === 'object' ? 'an object' : t === 'function' ? 'an imported/derived value' : `a ${t}`;
}

const WORD = /\w/;
/** Find the `{` opening the FIRST `name( { … } )` call that sits at a CODE position — skipping line and
 *  block comments and string literals, so a commented-out or stringified `ogygia({…})` isn't matched.
 *  Returns the index of the `{`, or -1 if there's no such call. */
function find_call_object_start(src: string, name: string): number {
	let i = 0;
	let str: string | null = null;
	let line_comment = false;
	let block_comment = false;
	while (i < src.length) {
		const c = src[i];
		const c2 = src[i + 1];
		if (line_comment) { if (c === '\n') line_comment = false; i++; continue; }
		if (block_comment) { if (c === '*' && c2 === '/') { block_comment = false; i += 2; continue; } i++; continue; }
		if (str) { if (c === '\\') i += 2; else { if (c === str) str = null; i++; } continue; }
		if (c === '/' && c2 === '/') { line_comment = true; i += 2; continue; }
		if (c === '/' && c2 === '*') { block_comment = true; i += 2; continue; }
		if (c === '"' || c === "'" || c === '`') { str = c; i++; continue; }
		// a code position: match `name` on a word boundary, then `(` (ws), then `{`
		if (src.startsWith(name, i) && !WORD.test(src[i - 1] ?? '') && !WORD.test(src[i + name.length] ?? '')) {
			let j = i + name.length;
			while (j < src.length && /\s/.test(src[j])) j++;
			if (src[j] === '(') {
				let k = j + 1;
				while (k < src.length && /\s/.test(src[k])) k++;
				if (src[k] === '{') return k;
			}
		}
		i++;
	}
	return -1;
}

/** Extract the FIRST code-level `name(<object literal>)` call's object source (brace-balanced, string- and
 *  comment-aware). Returns the `{ … }` text or null. A commented-out / stringified call is ignored. */
export function extract_call_object(src: string, name: string): string | null {
	let i = find_call_object_start(src, name);
	if (i < 0) return null;
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

/** Inspect the evaluated `ogygia({…})` config and report — deliberately — everything the in-browser
 *  preview can't apply: build-time-only keys, unknown markdown options, illegal value types, and
 *  imports/objects that can't run in the browser. Each note carries a hint on what's allowed / to change.
 *  Never throws (each read is guarded). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function diagnose(cfg: any): ConfigNote[] {
	const notes: ConfigNote[] = [];
	if (!cfg || typeof cfg !== 'object') return notes;
	try {
		// Top-level ogygia keys other than `content` are build-time and don't affect a single-page preview.
		for (const k of Object.keys(cfg)) {
			if (k === 'content' || k === 'markdown') continue;
			notes.push({
				level: 'info',
				message: `ogygia({ ${k} }) doesn't affect the preview.`,
				hint: `The preview reads only content.markdown. ${k} (loaders, router, regions, images, …) runs in a real build.`
			});
		}
		const content = cfg.content && typeof cfg.content === 'object' ? cfg.content : undefined;
		if (content) {
			for (const k of Object.keys(content)) {
				if (k === 'markdown') continue;
				notes.push({
					level: 'info',
					message: `content.${k} doesn't affect the preview.`,
					hint: `The preview reads only content.markdown; ${k} is build-time.`
				});
			}
		}
		const md = (content ? content.markdown : undefined) ?? cfg.markdown;
		if (md && typeof md === 'object') {
			for (const k of Object.keys(md)) {
				if (!(ALLOWED_MARKDOWN_KEYS as readonly string[]).includes(k)) {
					notes.push({
						level: 'warn',
						message: `markdown.${k} isn't a preview option — it's ignored.`,
						hint: `Allowed markdown options: ${ALLOWED_MARKDOWN_LIST}.`
					});
					continue;
				}
				// Known key, wrong type → the sanitizer drops it; say so with the expected type.
				const v = md[k];
				if ((SAFE_BOOL_KEYS as readonly string[]).includes(k) && typeof v !== 'boolean') {
					notes.push({
						level: 'warn',
						message: `markdown.${k} must be true or false — got ${type_label(v)}, so it's ignored.`,
						hint: `Use \`${k}: true\` or \`${k}: false\`.`
					});
				}
			}
			// themes must be Shiki theme NAMES (strings). An imported theme object can't run in-browser.
			if ('themes' in md) {
				const t = md.themes;
				if (!t || typeof t !== 'object' || Array.isArray(t)) {
					notes.push({
						level: 'warn',
						message: `markdown.themes must name bundled Shiki themes — got ${type_label(t)}.`,
						hint: `Use e.g. { light: 'github-light', dark: 'github-dark' }; an imported theme object can't run in the preview.`
					});
				} else {
					for (const side of ['light', 'dark'] as const) {
						if (t[side] != null && typeof t[side] !== 'string')
							notes.push({
								level: 'warn',
								message: `markdown.themes.${side} must be a theme name — got ${type_label(t[side])}, so it's ignored.`,
								hint: `Use a bundled Shiki theme name, e.g. '${side === 'light' ? 'github-light' : 'github-dark'}'.`
							});
					}
				}
			}
			// Custom code transformers can't run in the browser — only the built-in two do.
			if (md.code && typeof md.code === 'object' && Array.isArray(md.code.transformers)) {
				const dropped = md.code.transformers.filter(
					(x: unknown) => x == null || typeof x !== 'object' || Array.isArray(x)
				).length;
				if (dropped > 0)
					notes.push({
						level: 'warn',
						message: `${dropped} custom code transformer${dropped > 1 ? 's are' : ' is'} ignored in the preview.`,
						hint: `Only the built-in diff_markers() and inline_markers() run in-browser.`
					});
			}
		}
	} catch {
		/* a pathological throwing config → whatever notes we gathered; the eval-error note covers the rest */
	}
	return notes;
}

/** Parse a `vite.config.*` source → the safe markdown config PLUS deliberate notes on anything the
 *  preview couldn't apply. `markdown` is null when there's no ogygia() call or it's unparseable. */
export function parse_config(configSrc: string): { markdown: ReplMarkdownConfig | null; notes: ConfigNote[] } {
	const objSrc = extract_call_object(configSrc, 'ogygia');
	if (!objSrc) return { markdown: null, notes: [] };
	const stub = (): undefined => undefined;
	const helpers: Record<string, unknown> = {
		diff_markers, inline_markers, diffMarkers: diff_markers, inlineMarkers: inline_markers
	};
	const sandbox = new Proxy(helpers, {
		has: () => true, // trap EVERY free-variable lookup so an unknown import can't reach the real scope
		get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : stub)
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let cfg: any;
	try {
		// eslint-disable-next-line no-new-func
		cfg = new Function('__S__', `with(__S__){ return (${objSrc}); }`)(sandbox);
	} catch {
		return {
			markdown: null,
			notes: [
				{
					level: 'error',
					message: `The ogygia() config couldn't be evaluated.`,
					hint: `Check it for a syntax error or a throwing value — the preview is using defaults.`
				}
			]
		};
	}
	// Reads below can still throw lazily (a getter / Proxy). Any of it → defaults, plus a clear note.
	try {
		const notes = diagnose(cfg);
		const md = cfg?.content?.markdown ?? cfg?.markdown;
		const markdown = md && typeof md === 'object' ? sanitize(md) : null;
		return { markdown, notes };
	} catch {
		return {
			markdown: null,
			notes: [
				{
					level: 'error',
					message: `The ogygia() config threw while reading its options.`,
					hint: `Avoid getters or proxies that throw — the preview is using defaults.`
				}
			]
		};
	}
}

/** Back-compat: just the safe markdown config (used to CONFIGURE the pipeline; notes are for display). */
export function parse_config_markdown(configSrc: string): ReplMarkdownConfig | null {
	return parse_config(configSrc).markdown;
}
