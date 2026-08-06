import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { collectCaptureInfo, collectSnippetNames } from './free-vars.js';

export const ISLAND_DIR = '.ogygia';

/** Cheap source scan: only hosts that mention region import attributes need AST work. */
const REGION_IMPORT_HINT = /hydrate|defer|preset/;

/** Deterministic short id for a region (stable across dev + build).
 * When `salt` is set (production `OGYGIA_SECRET`), ids are not offline-computable (P1-ID).
 * Paths are always posix so SSR/client builds agree across OS path separators. */
export function islandId(relHostPath: string, index: string | number, salt = '') {
	const rel = String(relHostPath).split(/[/\\]/).join('/');
	const msg = salt ? `${salt}\0${rel}::${index}` : `${rel}::${index}`;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}

/** True if `val` looks like a CSS media query (must contain a balanced-ish `(…)`). */
function is_media_query(val: string) {
	const open = val.indexOf('(');
	return open !== -1 && val.indexOf(')', open) !== -1;
}

/** A curated allowlist of JS globals that must never be treated as captured props. */
const GLOBAL_ALLOW = new Set([
	'globalThis', 'window', 'document', 'console', 'Math', 'JSON', 'Date', 'Array',
	'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Map', 'Set',
	'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError', 'RangeError', 'Function',
	'undefined', 'null', 'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
	'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'fetch',
	'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
	'structuredClone', 'URL', 'URLSearchParams', 'Intl', 'crypto', 'navigator', 'location',
	'localStorage', 'sessionStorage', 'history', 'customElements', 'CustomEvent', 'Event'
]);

function is_global(name) {
	if (GLOBAL_ALLOW.has(name)) return true;
	try {
		return name in globalThis;
	} catch {
		return false;
	}
}

/** Reconstruct an import declaration without its `with { ... }` attributes clause. */
function clean_import_text(source, node) {
	// slice up to the end of the module-specifier string literal, then terminate.
	return source.slice(node.start, node.source.end) + ';';
}

function script_lang_attr(scriptNode) {
	if (!scriptNode) return '';
	for (const attr of scriptNode.attributes ?? []) {
		if (attr.name === 'lang' && Array.isArray(attr.value) && attr.value[0]?.data) {
			return ` lang="${attr.value[0].data}"`;
		}
	}
	return '';
}

/** Map a hydrate strategy (+ options) to the Island wrapper attribute markup. */
function strategy_to_attr(strategy, options) {
	if (!strategy || strategy === 'load') return 'load';
	if (strategy === 'idle') return 'idle';
	if (strategy === 'visible') {
		// `margin` (IntersectionObserver rootMargin) rides as the string form of `visible`.
		return options && options.margin != null ? `visible=${JSON.stringify(options.margin)}` : 'visible';
	}
	// media query (the strategy IS the query string)
	return `media=${JSON.stringify(strategy)}`;
}

const REMOUNT_STRATEGIES = new Set(['cache', 'empty', 'swr']);
/** Schedule keywords shared by `hydrate`, `defer` and `remount.when`. */
const SCHEDULE_KEYWORDS = new Set(['load', 'idle', 'visible']);

/**
 * Normalize preset `remount` (string or `{ strategy, when? }`) for hydrate:none.
 * @returns {{ strategy: string, when?: string } | undefined}
 */
function parse_remount(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'string') {
		if (!REMOUNT_STRATEGIES.has(raw)) {
			throw err(names, `unknown remount '${raw}'. Use 'cache' | 'empty' | 'swr'.`);
		}
		return { strategy: raw };
	}
	if (typeof raw === 'object' && raw !== null && typeof raw.strategy === 'string') {
		if (!REMOUNT_STRATEGIES.has(raw.strategy)) {
			throw err(names, `unknown remount.strategy '${raw.strategy}'. Use 'cache' | 'empty' | 'swr'.`);
		}
		/** @type {{ strategy: string, when?: string }} */
		const out = { strategy: raw.strategy };
		if (raw.when != null) {
			if (raw.strategy !== 'swr') {
				throw err(names, `\`remount.when\` is only valid with remount strategy 'swr'.`);
			}
			const when = String(raw.when);
			// An unvalidated typo would reach the runtime as a media query that never matches —
			// i.e. silently no revalidation. Same vocabulary as `hydrate` / `defer`.
			if (!SCHEDULE_KEYWORDS.has(when) && !is_media_query(when)) {
				throw err(
					names,
					`unknown remount.when '${when}'. Use 'load' | 'idle' | 'visible' | a media query.`
				);
			}
			out.when = when;
		}
		return out;
	}
	throw err(names, `\`remount\` must be 'cache' | 'empty' | 'swr' or \`{ strategy, when? }\`.`);
}

/** Escape a static text chunk for use inside a template literal. */
function escape_template_text(text) {
	return String(text).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Build a `__props={…}` literal from a lake `<Component>` tag's attributes.
 * Only used for `remount: 'swr'` — the endpoint re-renders the component with these props, so the
 * literal must reproduce the authored values EXACTLY (SSR itself keeps the original tag verbatim).
 */
function lake_props_literal(source, node) {
	const parts = [];
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'SpreadAttribute' && attr.expression) {
			parts.push(`...${source.slice(attr.expression.start, attr.expression.end)}`);
			continue;
		}
		if (attr.type !== 'Attribute') continue;
		const name = attr.name;
		if (typeof name !== 'string' || name.startsWith('__')) continue;
		const val = attr.value;
		if (val === true || val == null || val === undefined) {
			parts.push(`${JSON.stringify(name)}: true`);
			continue;
		}
		// Svelte's AST does NOT wrap a lone expression value in an array (`n={x}` → ExpressionTag,
		// `n="x"` → [Text]). Treating both as arrays silently dropped every mustache-valued prop.
		const chunk_list = Array.isArray(val) ? val : [val];
		if (chunk_list.length === 0) continue;
		if (chunk_list.length === 1) {
			const only = chunk_list[0];
			if (only.type === 'Text') {
				parts.push(`${JSON.stringify(name)}: ${JSON.stringify(only.data)}`);
				continue;
			}
			// Mustache / expression tag — shorthand when the Identifier matches the attr name.
			if (only.expression?.type === 'Identifier' && only.expression.name === name) {
				parts.push(name);
			} else if (only.expression) {
				parts.push(`${JSON.stringify(name)}: ${source.slice(only.expression.start, only.expression.end)}`);
			}
			continue;
		}
		// Concatenation (`label="Hi {name}"`) — a template literal keeps every chunk. Taking only
		// the expression would silently drop the static text around it.
		const chunks = chunk_list.map((chunk) =>
			chunk.type === 'Text'
				? escape_template_text(chunk.data)
				: chunk.expression
					? '${' + source.slice(chunk.expression.start, chunk.expression.end) + '}'
					: ''
		);
		parts.push(`${JSON.stringify(name)}: \`${chunks.join('')}\``);
	}
	return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

/**
 * Svelte 5 event attributes (`onclick`, …) that cannot cross devalue for remount:swr.
 * Deliberately NOT `/^on[a-z]+$/` — that falsely rejects data props like `online={x}`.
 */
const SWR_EVENT_ATTR = new Set([
	'onclick',
	'ondblclick',
	'oncontextmenu',
	'onauxclick',
	'onpointerdown',
	'onpointerup',
	'onpointermove',
	'onpointerenter',
	'onpointerleave',
	'onpointercancel',
	'onpointerover',
	'onpointerout',
	'onmousedown',
	'onmouseup',
	'onmousemove',
	'onmouseenter',
	'onmouseleave',
	'onmouseover',
	'onmouseout',
	'onkeydown',
	'onkeyup',
	'onkeypress',
	'onfocus',
	'onblur',
	'onfocusin',
	'onfocusout',
	'oninput',
	'onbeforeinput',
	'onchange',
	'onsubmit',
	'onreset',
	'onscroll',
	'onwheel',
	'ontouchstart',
	'ontouchend',
	'ontouchmove',
	'ontouchcancel',
	'ondrag',
	'ondragstart',
	'ondragend',
	'ondragenter',
	'ondragleave',
	'ondragover',
	'ondrop',
	'oncopy',
	'oncut',
	'onpaste',
	'onanimationstart',
	'onanimationend',
	'onanimationiteration',
	'ontransitionend',
	'ontransitionrun',
	'ontransitionstart',
	'ontransitioncancel',
	'onload',
	'onerror',
	'ontoggle',
	'onselect',
	'oninvalid',
	'onformdata'
]);

/**
 * Everything a `remount: 'swr'` region needs must survive the wire: the endpoint re-renders the
 * component from devalue'd PROPS alone. Children (snippets) and `bind:` targets cannot cross, and
 * silently losing them on revalidate would be worse than refusing the build.
 */
function assert_swr_lake_crossable(node, err) {
	const kids = (node.fragment?.nodes ?? []).filter(
		(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
	);
	if (kids.length) {
		throw err(
			node.name,
			`\`remount: 'swr'\` region <${node.name}> cannot have children — the revalidate endpoint re-renders it from serialized props only, so snippets cannot cross. Move the content inside the component, or use remount 'cache' / 'empty'.`
		);
	}
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'SpreadAttribute') continue;
		if (attr.type !== 'Attribute') {
			throw err(
				node.name,
				`\`remount: 'swr'\` region <${node.name}> cannot use \`${attr.type === 'BindDirective' ? 'bind:' + attr.name : attr.name || attr.type}\` — only plain attributes and spreads can be serialized for the revalidate endpoint.`
			);
		}
		const name = attr.name;
		// Svelte 5 event attributes are lowercase `onclick` / `onpointerdown` / … (distinct from
		// `on:click` OnDirective, already rejected above). Callback props with that shape cannot
		// cross devalue — rejecting at build avoids a silent remount:'cache' degrade at mint.
		// Match known DOM events only — `/^on[a-z]+$/` falsely rejects data props like `online={x}`.
		if (typeof name === 'string' && SWR_EVENT_ATTR.has(name)) {
			throw err(
				node.name,
				`\`remount: 'swr'\` region <${node.name}> cannot use \`${name}\` — event/callback attributes cannot be serialized for the revalidate endpoint. Pass serializable data props instead.`
			);
		}
		// Inline function values on any attr (`render={() => …}`) likewise cannot cross.
		const val = attr.value;
		const chunk_list = Array.isArray(val) ? val : val != null && val !== true ? [val] : [];
		for (const chunk of chunk_list) {
			const t = chunk?.expression?.type;
			if (t === 'ArrowFunctionExpression' || t === 'FunctionExpression') {
				throw err(
					node.name,
					`\`remount: 'swr'\` region <${node.name}> cannot use a function value for \`${name}\` — functions cannot be serialized for the revalidate endpoint.`
				);
			}
		}
	}
}

/** Resolve an import specifier to an absolute .svelte path (for SWR server entries). */
function resolve_component_path(spec, host_id, ctx) {
	if (typeof spec !== 'string') return null;
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		return ctx.pathModule.join(ctx.libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
	}
	if (spec.startsWith('.')) {
		return ctx.pathModule.resolve(ctx.pathModule.dirname(host_id), spec);
	}
	return null;
}

/**
 * @typedef {Object} TransformResult
 * @property {string} code rewritten host source
 * @property {unknown} map source map
 * @property {Array<{id:string, virtualPath:string, source:string, hostPath:string}>} islands
 */

/**
 * @param {string} source
 * @param {string} id absolute host path
 * @param {Object} ctx
 * @param {string} ctx.root project root (abs)
 * @param {string} ctx.libDir abs path for `$lib`
 * @param {(abs:string)=>string|null} ctx.readFile sync file reader for filename-strategy lookup
 * @param {(hostPath:string, index:number)=>string} ctx.virtualPathFor build a fake .svelte path
 * @returns {TransformResult|null}
 */
export function transformHost(source, id, ctx) {
	// cheap bailout — the library only touches region imports (`hydrate`/`defer`/`preset`)
	if (!REGION_IMPORT_HINT.test(source)) return null;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instance_body = ast.instance?.content?.body ?? [];
	const lang = script_lang_attr(ast.instance) || script_lang_attr(ast.module);

	const path = ctx.pathModule;
	// Posix-relative host path — island ids must not drift across Windows/POSIX build legs.
	const rel_host = path.relative(ctx.root, id).split(/[/\\]/).join('/');

	// --- collect host imports & region marks (the two-key region model) --------
	// The authoring syntax is the import attribute, one concern per key:
	//   import Comp from './Comp.svelte' with { hydrate: 'visible', margin: '200px' };
	//   import Comp from './Comp.svelte' with { hydrate: '(min-width: 768px)' };
	//   import Comp from './Comp.svelte' with { defer: 'load' };   // deferred HTML hole
	// Values MUST be string literals (ES import-attribute spec). See DESIGN.md.
	/** localName -> { node, cleaned } */
	const imports = new Map();
	/** localName -> { strategy, options } */
	const marked_components = new Map();
	const imports_to_strip = new Set(); // ImportDeclaration nodes to remove from host

	const KNOWN_STRATEGIES = new Set(['load', 'idle', 'visible']);
	const err = (specifiers, msg) =>
		new Error(`[ogygia] ${rel_host}: import { ${specifiers} } — ${msg}`);

	for (const node of instance_body) {
		if (node.type !== 'ImportDeclaration') continue;
		const cleaned = clean_import_text(source, node);
		for (const spec of node.specifiers) imports.set(spec.local.name, { node, cleaned });

		const attr_list = (node.attributes ?? []).filter((a) => a.type === 'ImportAttribute');
		if (attr_list.length === 0) continue;

		/** @type {Map<string,string>} raw inline attributes */
		const inline = new Map();
		for (const a of attr_list) inline.set(a.key.name ?? a.key.value, String(a.value.value));
		const names = node.specifiers.map((sp) => sp.local.name).join(', ');

		// Only imports carrying a REGION key (`hydrate` | `defer` | `preset`) are ours. A standard
		// import attribute on an UNRELATED import — `import data from './d.json' with { type: 'json' }`,
		// an `with { type: 'macro' }`, etc. — is left completely untouched (its `with{}` preserved), even
		// in a file that also declares islands. We only validate + strip the imports we actually claim.
		const REGION_KEYS = ['hydrate', 'defer', 'preset'];
		if (!REGION_KEYS.some((k) => inline.has(k))) continue;

		// The import block carries EXACTLY ONE of `hydrate` | `defer` | `preset`. No option keys
		// inline — all tuning (margin, remount, …) lives in plugin config (ogygia({ presets })).
		/** @type {Map<string,string>} effective attributes (from a preset, or the single inline key) */
		let attrs;
		/** @type {{ strategy: string, when?: string } | undefined} */
		let remount_opt;
		let from_preset = null;
		if (inline.has('preset')) {
			if (inline.size > 1) {
				throw err(names, '`preset` must be the only import attribute — put its options (margin, remount, …) in the preset definition (ogygia({ presets })).');
			}
			from_preset = inline.get('preset');
			const preset = ctx.presets && ctx.presets[from_preset];
			if (!preset) {
				const avail = Object.keys(ctx.presets || {});
				throw err(names, `unknown preset '${from_preset}'. Available: ${avail.length ? avail.join(', ') : '(none)'}.`);
			}
			attrs = new Map();
			for (const [k, v] of Object.entries(preset)) {
				if (v == null) continue;
				if (k === 'remount') {
					remount_opt = parse_remount(v, err, names);
					continue;
				}
				attrs.set(k, String(v));
			}
			if (!attrs.has('hydrate') && !attrs.has('defer')) {
				throw err(
					names,
					`preset '${from_preset}' must set \`hydrate\` or \`defer\` — a margin-only (or empty) preset is a no-op.`
				);
			}
		} else {
			// inline may carry only `hydrate` or `defer` (the hydrate+defer pair is a roadmap error below)
			for (const k of inline.keys()) {
				if (k !== 'hydrate' && k !== 'defer') {
					throw err(
						names,
						`\`${k}\` is not allowed inline. Use \`hydrate\`, \`defer\`, or a named \`preset\` — options like \`margin\` / \`remount\` belong in plugin config (ogygia({ presets })).`
					);
				}
			}
			attrs = inline;
		}

		// Only UNKNOWN keys are errors. Presets are TOLERANT: a known-but-inapplicable key
		// (e.g. `margin` with `hydrate: 'load'`) is silently ignored — it applies wherever it's
		// relevant. `margin` / `remount` never reach here inline (rejected above).
		const SCHEMA = new Set(['hydrate', 'defer', 'margin']);
		for (const k of attrs.keys()) {
			if (!SCHEMA.has(k)) {
				throw err(names, from_preset ? `unknown key \`${k}\` in preset '${from_preset}'.` : `unknown import attribute \`${k}\`.`);
			}
		}
		if (remount_opt && attrs.get('hydrate') !== 'none') {
			throw err(names, `\`remount\` is only valid with \`hydrate: 'none'\`.`);
		}
		if (attrs.has('defer') && attrs.has('hydrate')) {
			throw err(names, "`defer` + `hydrate` together is not yet supported (roadmap: deferred client island — see DESIGN.md).");
		}

		// `defer` -> SERVER island (render: defer, hydrate: none). Its VALUE is the fetch-timing for
		// the hole, symmetric with `hydrate`'s value being the hydrate-timing: 'load' (immediate,
		// preload-hinted) | 'idle' (requestIdleCallback) | 'visible' (IntersectionObserver) | a media
		// query. The old boolean spelling `defer: 'true'` is retired — point authors at `defer: 'load'`.
		if (attrs.has('defer')) {
			const dval = attrs.get('defer');
			if (dval === 'true') {
				throw err(
					names,
					"`defer: 'true'` is no longer valid — a server island now takes a fetch-timing value. Use `defer: 'load'` (immediate + preload) | 'idle' | 'visible' | a media query. See DESIGN.md."
				);
			}
			let when;
			if (KNOWN_STRATEGIES.has(dval)) when = dval; // load | idle | visible
			else if (is_media_query(dval)) when = dval; // media query is the value itself
			else throw err(names, `unknown defer timing '${dval}'. Use 'load' | 'idle' | 'visible' | a media query.`);

			// `margin` applies only to `visible` (tolerantly ignored otherwise), same as hydrate.
			const options: { when: string; margin?: string } = { when };
			if (when === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy: 'server', options });
			imports_to_strip.add(node);
			continue;
		}

		if (attrs.has('hydrate')) {
			const val = attrs.get('hydrate');
			if (val === 'none') {
				// hydrate: 'none' is a LAKE (render: page, hydrate: none). A lake INSIDE a hydrated
				// island freezes its subtree: SSR renders it inline, its JS ships in NO client chunk
				// (the island's client module swaps the import for a placeholder), and the runtime
				// lifts/restores its DOM around the parent hydrate. A lake in the dead shell is a
				// no-op plain component (dev-warned below). See DESIGN.md.
				// Always strip the `with{}` later (shell keeps cleaned import; unused/island lakes
				// drop the host binding). Never leave `with { hydrate: 'none' }` in emitted source.
				/** @type {{ remount?: string, when?: string, margin?: string }} */
				const lake_opts = {};
				if (remount_opt) {
					lake_opts.remount = remount_opt.strategy;
					if (remount_opt.when) lake_opts.when = remount_opt.when;
					// `margin` rides along for a `remount: { strategy: 'swr', when: 'visible' }`
					// revalidate, same tolerance as `hydrate: 'visible'`.
					if (remount_opt.strategy === 'swr' && remount_opt.when === 'visible') {
						lake_opts.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
					}
				}
				for (const spec of node.specifiers) {
					marked_components.set(spec.local.name, { strategy: 'lake', options: lake_opts });
				}
				continue;
			}
			if (val === 'false') {
				// Import-attribute values are strings; the "no hydration" value is the WORD 'none'
				// (not the boolean-looking 'false'). No silent alias — point the author at 'none'.
				throw err(names, "`hydrate: 'false'` is not valid — use `hydrate: 'none'` for a lake (a frozen region inside a hydrated island). See DESIGN.md.");
			}
			let strategy;
			if (KNOWN_STRATEGIES.has(val)) strategy = val;
			else if (is_media_query(val)) strategy = val; // media query is the value itself
			else throw err(names, `unknown hydrate strategy '${val}'. Use 'load' | 'idle' | 'visible' | a media query.`);

			// `margin` applies only to `visible` (tolerantly ignored otherwise). Falls back to the
			// plugin-level default ogygia({ visible: { margin } }).
			const options: { margin?: string } = {};
			if (strategy === "visible") {
				options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy, options });
			imports_to_strip.add(node);
			continue;
		}
		// otherwise: a normal import that happens to carry other import attributes — leave it.
	}

	// host top-level snippet names (for cross-boundary error detection)
	const host_snippet_names = collectSnippetNames(ast.fragment?.nodes ?? []);

	// Names DECLARED at the top level of the host scripts (instance + module) — `let`/`const`/`var`,
	// functions, classes. These are captured even when they shadow a JS global (e.g. `const Date =
	// …`): a host-declared binding always wins over the globals allowlist, matching JS scope rules.
	const host_local_names = new Set();
	const add_decl_names = (pat) => {
		if (!pat) return;
		switch (pat.type) {
			case 'Identifier':
				host_local_names.add(pat.name);
				break;
			case 'ObjectPattern':
				for (const prop of pat.properties) {
					if (prop.type === 'RestElement') add_decl_names(prop.argument);
					else add_decl_names(prop.value);
				}
				break;
			case 'ArrayPattern':
				for (const el of pat.elements) add_decl_names(el);
				break;
			case 'AssignmentPattern':
				add_decl_names(pat.left);
				break;
			case 'RestElement':
				add_decl_names(pat.argument);
				break;
		}
	};
	const scan_host_decls = (body) => {
		for (const node of body ?? []) {
			if (node.type === 'VariableDeclaration') {
				for (const d of node.declarations) add_decl_names(d.id);
			} else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
				host_local_names.add(node.id.name);
			}
		}
	};
	scan_host_decls(instance_body);
	scan_host_decls(ast.module?.content?.body ?? []);

	// --- find island units in the template ---------------------------------
	// marked-component usages: { node (svelte template node), strategy, options }
	const units = [];
	const CHILD_KEYS = ['consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch', 'fragment'];
	// LAKE local names used in the DEAD SHELL (top level, not inside any island): a no-op. We clean
	// their import (drop the `with{}`) and leave them as plain components (dev-warned at build).
	const shell_lake_locals = new Set();
	const visit = (nodes) => {
		for (const node of nodes ?? []) {
			if (node.type === 'Component' && marked_components.has(node.name)) {
				const mark = marked_components.get(node.name);
				if (mark.strategy === 'lake') {
					// top-level lake = no-op; descend through it so a shell-lake's inner islands still
					// hydrate (the lake never became a hydration boundary here).
					shell_lake_locals.add(node.name);
					for (const k of CHILD_KEYS) if (node[k]?.nodes) visit(node[k].nodes);
					continue;
				}
				units.push({ node, strategy: mark.strategy, options: mark.options });
				continue; // island/server: do not descend
			}
			// descend into child fragments
			for (const k of CHILD_KEYS) if (node[k]?.nodes) visit(node[k].nodes);
		}
	};
	visit(ast.fragment?.nodes ?? []);

	if (ctx.dev && shell_lake_locals.size) {
		for (const name of shell_lake_locals) {
			console.warn(
				`[ogygia] ${rel_host}: <${name}> has \`hydrate: 'none'\` (lake) in the page shell — that is a no-op (the shell is already dead). A lake only has meaning INSIDE a hydrated island. Rendering it as a plain component.`
			);
		}
	}

	// Marked hydrate/defer imports must appear as a static <Component> tag when referenced.
	// Completely unused marked imports are stripped (dead code). Dynamic `<svelte:component>`,
	// dotted `<Menu.Item>`, or other non-tag refs still strip the import — refuse with a build error.
	// Walk script + markup ASTs (not raw source) so text like "no usage of C" is not a false positive.
	const used_as_unit = new Set(units.map((u) => u.node.name));
	const ast_refs_local = (root, local) => {
		let found = false;
		const walk = (node) => {
			if (found || !node || typeof node !== 'object') return;
			if (node.type === 'Identifier' && node.name === local) {
				found = true;
				return;
			}
			// Dotted component tags (`Menu.Item`) are a single Component.name string, not Identifiers.
			if (node.type === 'Component') {
				const n = node.name || '';
				if (n === local || n.startsWith(local + '.')) {
					found = true;
					return;
				}
			}
			for (const k of Object.keys(node)) {
				if (k === 'start' || k === 'end' || k === 'loc') continue;
				const v = node[k];
				if (Array.isArray(v)) for (const c of v) walk(c);
				else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
			}
		};
		if (Array.isArray(root)) for (const n of root) walk(n);
		else walk(root);
		return found;
	};
	const marked_import_referenced = (local) => {
		for (const n of instance_body) {
			if (n.type === 'ImportDeclaration') continue;
			if (ast_refs_local(n, local)) return true;
		}
		return ast_refs_local(ast.fragment?.nodes ?? [], local);
	};
	for (const [local, mark] of marked_components) {
		if (mark.strategy === 'lake') continue;
		if (used_as_unit.has(local)) continue;
		if (marked_import_referenced(local)) {
			throw err(
				local,
				`region import '${local}' is never used as a static component tag \`<${local} …>\`. ` +
					`Dynamic \`<svelte:component>\`, dotted tags like \`<Menu.Item>\`, and non-tag references are not supported — the import would be stripped and break the build.`
			);
		}
		// else: unused — strip via imports_to_strip (already registered)
	}

	const has_lake_mark = [...marked_components.values()].some((m) => m.strategy === 'lake');
	if (units.length === 0 && imports_to_strip.size === 0 && !has_lake_mark) return null;

	const s = new MagicString(source);
	const islands = [];
	// LAKE local names hoisted into some island (their host import is now unused -> stripped).
	const island_lake_locals = new Set();
	// LAKE region ids (metadata-only client entries, unless remount:swr adds a server module).
	const lake_region_ids = [];
	/** @type {Array<{ id: string, local: string, remount: string, when?: string, componentPath: string | null }>} */
	const swr_lakes = [];
	const preamble_imports = [];
	// The transform emits a private wrapper component (not a public API). Component
	// tags must start uppercase or Svelte parses them as plain HTML elements.
	const wrapper_name = 'OgygiaIsland__Wrapper';
	const server_wrapper_name = 'OgygiaServerIsland__Wrapper';
	const lake_region_name = 'OgygiaLakeRegion__Wrapper';
	let wrapper_imported = false;
	let server_wrapper_imported = false;

	/** Find a reserved `{#snippet ogygiaFallback()}` block among a component's children. */
	const find_fallback_snippet = (node) => {
		for (const child of node.fragment?.nodes ?? []) {
			if (child.type === 'SnippetBlock' && child.expression?.name === 'ogygiaFallback') return child;
		}
		return null;
	};

	units.forEach((unit, index) => {
		const iid = islandId(rel_host, index, ctx.idSalt || '');
		const virtualPath = ctx.virtualPathFor(id, iid);
		const comp_var = `__OgygiaIsland_${index}`;
		const is_server = unit.strategy === 'server';

		// SERVER island: the reserved `ogygiaFallback` snippet renders into the page immediately
		// (kept in host scope, so it can reference host vars directly). The island component
		// itself is hoisted WITHOUT the fallback and rendered only by the `/🏝️ogygia🏝️` endpoint.
		const fallback_node = is_server ? find_fallback_snippet(unit.node) : null;

		// The subtree we hoist + analyse for free vars. For server islands, strip the fallback.
		let hoisted_source;
		let subtree_nodes;
		if (fallback_node) {
			hoisted_source =
				source.slice(unit.node.start, fallback_node.start) +
				source.slice(fallback_node.end, unit.node.end);
			// shallow-clone the component node with the fallback snippet removed for analysis
			const filtered = {
				...unit.node,
				fragment: {
					...unit.node.fragment,
					nodes: unit.node.fragment.nodes.filter((n) => n !== fallback_node)
				}
			};
			subtree_nodes = [filtered];
		} else {
			hoisted_source = source.slice(unit.node.start, unit.node.end);
			subtree_nodes = [unit.node];
		}

		// LAKES: a `hydrate: 'none'` component used inside THIS island (hydrate OR defer). Wrap
		// each in `<OgygiaLakeRegion>` (hydrate=none + remount policy); record the local so the
		// client build swaps its import for a placeholder. SSR keeps the real component.
		const island_lakes = [];
		{
			const lake_nodes = [];
			const scan_lakes = (nodes) => {
				for (const n of nodes ?? []) {
					if (n.type === 'Component' && marked_components.get(n.name)?.strategy === 'lake') {
						lake_nodes.push(n);
					}
					for (const k of CHILD_KEYS) if (n[k]?.nodes) scan_lakes(n[k].nodes);
				}
			};
			scan_lakes(unit.node.fragment?.nodes ?? []);
			if (lake_nodes.length) {
				const lake_ms = new MagicString(source);
				lake_nodes.forEach((ln, li) => {
					const lake_id = islandId(rel_host, `lake:${index}:${li}`, ctx.idSalt || '');
					const mark = marked_components.get(ln.name);
					const remount = mark?.options?.remount || 'cache';
					const when = mark?.options?.when || (remount === 'swr' ? 'load' : undefined);
					let lake_attrs =
						`__entry={${JSON.stringify(lake_id)}} __remount={${JSON.stringify(remount)}}`;
					if (remount === 'swr') {
						assert_swr_lake_crossable(ln, err);
						// Props are serialized into the signed endpoint ONLY for swr (the SSR pass keeps
						// the ORIGINAL tag, so nothing else depends on reproducing them as a literal).
						lake_attrs +=
							` __when={${JSON.stringify(when || 'load')}}` +
							` __props={${lake_props_literal(source, ln)}}`;
						if (mark?.options?.margin != null) {
							lake_attrs += ` __margin={${JSON.stringify(mark.options.margin)}}`;
						}
					}
					// WRAP the authored tag (never overwrite it): the lake keeps its own attributes,
					// bindings and CHILDREN, and stays a STATIC component reference so the client
					// build's placeholder swap still applies. A dynamic `<Component />` inside the
					// wrapper would add a `<!--[-->…<!--]-->` envelope inside the frozen region that
					// `#lift_lakes` carries away, and hydration then runs out of nodes (LAKE-ENVELOPE).
					lake_ms.appendLeft(ln.start, `<${lake_region_name} ${lake_attrs}>`);
					lake_ms.appendRight(ln.end, `</${lake_region_name}>`);
					island_lakes.push(ln.name);
					island_lake_locals.add(ln.name);
					lake_region_ids.push(lake_id);
					if (remount === 'swr') {
						const entry_spec = imports.get(ln.name)?.node?.source?.value;
						swr_lakes.push({
							id: lake_id,
							local: ln.name,
							remount,
							when: when || 'load',
							componentPath: resolve_component_path(entry_spec, id, ctx)
						});
					}
				});
				hoisted_source = lake_ms.slice(unit.node.start, unit.node.end);
			}
		}

		// free-variable analysis (+ mutation targets)
		const { free, mutated } = collectCaptureInfo(subtree_nodes);
		const used_import_nodes = new Set();
		const captured = [];
		for (const name of free) {
			if (imports.has(name)) {
				used_import_nodes.add(imports.get(name).node);
			} else if (host_snippet_names.has(name)) {
				throw new Error(
					`[ogygia] ${rel_host}: island references snippet \`${name}\` defined outside the island. ` +
						`Snippets cannot cross the island boundary. Define the snippet inside the island instead.`
				);
			} else if (host_local_names.has(name)) {
				// a host-declared binding — captured even if it shadows a global (JS scope wins)
				captured.push(name);
			} else if (is_global(name)) {
				// a true global (not shadowed by a host binding) — leave alone, never a prop
			} else {
				captured.push(name);
			}
		}

		// CAPTURED-STATE MUTATION GUARD. A captured host variable crosses the island boundary as a
		// serialized devalue SNAPSHOT — writing to it inside the island (assignment, `++`, compound
		// assign, destructuring-assignment, or `bind:`) updates nothing on the host and nothing that
		// survives a re-render. Fail the build, naming the variable + file, and point the author at
		// the fix: move mutable state INTO the island component.
		for (const name of mutated) {
			if (captured.includes(name)) {
				throw new Error(
					`[ogygia] ${rel_host}: island mutates captured host variable \`${name}\` — ` +
						`captured host state is a serialized snapshot, so writing to it inside the island updates nothing. ` +
						`Move mutable state inside the island component (declare \`${name}\` with \`$state\` in the island, ` +
						`or pass it as an initial value and keep the mutable copy local).`
				);
			}
		}

		// build virtual island module source: gather cleaned text per used import node
		const copied_imports = [];
		if (island_lakes.length) {
			copied_imports.push(`import { LakeRegion as ${lake_region_name} } from 'ogygia/internal';`);
		}
		for (const [, info] of imports) {
			if (used_import_nodes.has(info.node) && !copied_imports.includes(info.cleaned)) {
				copied_imports.push(info.cleaned);
			}
		}

		const props_line = captured.length ? `\tlet { ${captured.join(', ')} } = $props();` : '';
		const script_body = [...copied_imports.map((l) => '\t' + l), props_line]
			.filter(Boolean)
			.join('\n');
		const virtual_source = `<script${lang}>\n${script_body}\n</script>\n${hoisted_source}\n`;

		// Absolute path of the island entry component (the `import X from '…' with { hydrate }`).
		// Marked into the vite plugin's island_graph so `$app/*` inside THAT file (and its
		// transitive imports) resolve to client shims — not only imports written into the virtual
		// module. Kit's client build still emits csr=false page nodes that import the component
		// directly via `<Island __component={…} />`.
		const entry_spec = imports.get(unit.node.name)?.node?.source?.value;
		let componentPath = null;
		if (typeof entry_spec === 'string') {
			if (entry_spec === '$lib' || entry_spec.startsWith('$lib/')) {
				componentPath = ctx.pathModule.join(ctx.libDir, entry_spec === '$lib' ? '' : entry_spec.slice('$lib/'.length));
			} else if (entry_spec.startsWith('.')) {
				componentPath = ctx.pathModule.resolve(ctx.pathModule.dirname(id), entry_spec);
			}
		}

		islands.push({
			id: iid,
			virtualPath,
			source: virtual_source,
			hostPath: id,
			componentPath,
			server: is_server,
			kind: is_server ? 'defer' : 'hydrate',
			lakes: island_lakes
		});

		const props_obj = captured.length ? `{ ${captured.join(', ')} }` : '{}';

		if (is_server) {
			if (!server_wrapper_imported) {
				server_wrapper_imported = true;
				preamble_imports.push(
					`\timport { ServerIsland as ${server_wrapper_name} } from 'ogygia/internal/server';`
				);
			}
			// Keep a host import of the island component so its CSS is collected via the
			// PAGE's (SSR) import graph and linked into the page <head>. The wrapper never
			// renders it (the /🏝️ogygia🏝️ endpoint resolves it by id) — passing it as an
			// ignored `__component` prop just keeps the import from being tree-shaken.
			// On a csr=false page (the supported config) this ships zero client JS.
			preamble_imports.push(`\timport ${comp_var} from ${JSON.stringify(virtualPath)};`);
			const fallback_text = fallback_node
				? source.slice(fallback_node.start, fallback_node.end)
				: '';
			// Fetch timing of the hole (symmetric with hydrate). ServerIsland emits
			// `render="defer" when="<schedule>"` and a preload <link> ONLY for 'load'.
			const fetch_when = unit.options?.when || 'load';
			let server_attrs = ` __defer={${JSON.stringify(fetch_when)}}`;
			if (unit.options?.margin != null) server_attrs += ` __margin={${JSON.stringify(unit.options.margin)}}`;
			const replacement =
				`<${server_wrapper_name} __entry={${JSON.stringify(iid)}} ` +
				`__component={${comp_var}} __props={${props_obj}}${server_attrs}>` +
				fallback_text +
				`</${server_wrapper_name}>`;
			s.overwrite(unit.node.start, unit.node.end, replacement);
			return;
		}

		if (!wrapper_imported) {
			wrapper_imported = true;
			preamble_imports.push(`\timport { Island as ${wrapper_name} } from 'ogygia/internal';`);
		}

		// rewrite host: replace the unit with an <Island> wrapper element
		const strategy_attrs_text = strategy_to_attr(unit.strategy, unit.options);
		// dev: __entry is the vite dev URL of the island module; build: the manifest key (iid)
		const entry_value = ctx.dev ? ctx.devUrlFor(virtualPath) : iid;
		const replacement =
			`<${wrapper_name} ${strategy_attrs_text} ` +
			`__entry={${JSON.stringify(entry_value)}} __component={${comp_var}} __props={${props_obj}} />`;
		s.overwrite(unit.node.start, unit.node.end, replacement);

		preamble_imports.push(`\timport ${comp_var} from ${JSON.stringify(virtualPath)};`);
	});

	// Register lake regions: metadata-only on the client; remount:swr also gets a server-renderable
	// virtual module (signed endpoint re-renders the lake component with captured props).
	const swr_ids = new Set(swr_lakes.map((l) => l.id));
	for (const lake of swr_lakes) {
		if (!lake.componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: remount:'swr' lake '${lake.local}' needs a resolvable module path ($lib/… or relative).`
			);
		}
		const lake_virtual = ctx.virtualPathFor(id, lake.id);
		const lake_source =
			`<script${lang}>\n` +
			`\timport Comp from ${JSON.stringify(lake.componentPath)};\n` +
			`\tlet props = $props();\n` +
			`</script>\n` +
			`<Comp {...props} />\n`;
		islands.push({
			id: lake.id,
			virtualPath: lake_virtual,
			source: lake_source,
			hostPath: id,
			componentPath: lake.componentPath,
			server: true,
			kind: 'lake'
		});
	}
	for (const lake_id of lake_region_ids) {
		if (swr_ids.has(lake_id)) continue;
		islands.push({ id: lake_id, kind: 'lake' });
	}

	// LAKE host imports: always drop `with{}`. Hoisted-into-island or unused → strip the binding.
	// Shell-only lake (no-op) → keep a CLEANED import so it renders as a plain component.
	for (const [local, mark] of marked_components) {
		if (mark.strategy !== 'lake') continue;
		const info = imports.get(local);
		if (!info || imports_to_strip.has(info.node)) continue;
		if (shell_lake_locals.has(local) && !island_lake_locals.has(local)) {
			s.overwrite(info.node.start, info.node.end, info.cleaned); // shell use -> keep, drop with{}
		} else {
			imports_to_strip.add(info.node); // island-hoisted or unused -> remove entirely
		}
	}

	// strip island-marked imports (their `with{}` clause & now-unused binding)
	for (const node of imports_to_strip) {
		const pos = node as { start: number; end: number };
		s.remove(pos.start, pos.end);
	}

	// inject island component imports into the instance <script>
	if (preamble_imports.length) {
		if (ast.instance) {
			// insert right after the opening <script ...> tag
			const openTagEnd = source.indexOf('>', ast.instance.start) + 1;
			s.appendLeft(openTagEnd, '\n' + preamble_imports.join('\n'));
		} else {
			// no instance script; create one
			s.prepend(`<script${lang}>\n${preamble_imports.join('\n')}\n</script>\n`);
		}
	}

	return { code: s.toString(), map: s.generateMap({ hires: true }), islands };
}
