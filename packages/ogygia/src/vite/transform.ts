import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { foucCssVirtualId } from './fouc-css.js';

export { foucCssVirtualId } from './fouc-css.js';

export const ISLAND_DIR = '.ogygia';

/** Default import-attribute keys. Override via `ogygia({ importKeys })`. */
export const DEFAULT_IMPORT_KEYS = {
	hydrate: 'hydrate',
	defer: 'defer',
	preset: 'preset'
} as const;

/**
 * Import-attribute key names claimed by the transform (`with { hydrate | defer | preset }`).
 * Override via `ogygia({ importKeys })` when another tool already uses the default names.
 */
export type ImportKeys = {
	/** Client-island / lake attribute (default `'hydrate'`). */
	hydrate: string;
	/** Server-island attribute (default `'defer'`). */
	defer: string;
	/** Named preset attribute (default `'preset'`). */
	preset: string;
};

const JS_IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Merge partial `importKeys` with {@link DEFAULT_IMPORT_KEYS}.
 * Rejects empty strings, non-identifiers, and colliding role names.
 *
 * @param partial - Optional overrides for one or more roles.
 * @returns Fully resolved key map used by the transform.
 * @throws If a value is not a JS identifier or two roles share the same name.
 */
export function normalize_import_keys(partial?: Partial<ImportKeys> | null): ImportKeys {
	const hydrate = (partial?.hydrate ?? DEFAULT_IMPORT_KEYS.hydrate).trim();
	const defer = (partial?.defer ?? DEFAULT_IMPORT_KEYS.defer).trim();
	const preset = (partial?.preset ?? DEFAULT_IMPORT_KEYS.preset).trim();
	for (const [role, name] of [
		['hydrate', hydrate],
		['defer', defer],
		['preset', preset]
	] as const) {
		if (!name || !JS_IDENT.test(name)) {
			throw new Error(
				`[ogygia] importKeys.${role} must be a non-empty JS identifier (got ${JSON.stringify(partial?.[role])}).`
			);
		}
	}
	if (hydrate === defer || hydrate === preset || defer === preset) {
		throw new Error(
			'[ogygia] importKeys.hydrate, importKeys.defer, and importKeys.preset must be distinct.'
		);
	}
	return { hydrate, defer, preset };
}

/**
 * Cheap source-scan regex matching any of the configured import-attribute key names.
 * Used to skip AST work on hosts that cannot contain region imports.
 *
 * @param import_keys - Resolved key map from {@link normalize_import_keys}.
 */
export function import_keys_hint(import_keys: ImportKeys) {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`${esc(import_keys.hydrate)}|${esc(import_keys.defer)}|${esc(import_keys.preset)}`
	);
}

/** Deterministic short id for a region (stable across dev + build).
 * When `salt` is set (production `OGYGIA_SECRET`), ids are not offline-computable (P1-ID).
 * Paths are always posix so SSR/client builds agree across OS path separators. */
export function islandId(relHostPath: string, index: string | number, salt = '') {
	const rel = String(relHostPath).split(/[/\\]/).join('/');
	const msg = salt ? `${salt}\0${rel}::${index}` : `${rel}::${index}`;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}

/**
 * Deterministic client chunk path for a hydrate island (mirrors `ogygia-runtime.<hash>.js`).
 * SSR bakes this into `<ogygia-region entry>` so the sticky runtime can `import(entry)` with no
 * app-wide regions map — Kit builds server before client, so content-hashed Vite names can't hand off.
 */
export function islandChunkFileName(iid: string) {
	return `_app/immutable/ogygia-island.${iid}.js`;
}

/** Public URL for {@link islandChunkFileName} (leading slash, same shape as runtime-url). */
export function islandPublicUrl(iid: string) {
	return '/' + islandChunkFileName(iid);
}

/** Portable wrapper module id — SSR / csr=true host binding (Island/ServerIsland/Lake shell). */
export function wrapperVirtualId(iid: string) {
	return `virtual:ogygia/wrapper/${iid}.svelte`;
}

/**
 * csr=false CLIENT host binding target. Kit still emits those page nodes; pointing marked
 * imports here (instead of wrappers) keeps N island wrappers/entries out of the page graph so
 * `emitFile` owns hydrate modules and Rolldown does not thin-facade them. Hydration uses
 * `import(entry)` only — this stub is never loaded for island JS.
 *
 * Beside the stub the transform emits `import 'virtual:ogygia/fouc-css/<entry>'` so Kit still
 * links stylesheets (FOUC) via CSS-only side effects. Importing the full `.svelte` JS module
 * dual-owns it with the emitFile island entry and Rolldown thin-facades `ogygia-island.*`.
 * Omitting CSS entirely orphans rules (scoped class hashes, no stylesheet).
 */
export const CLIENT_BINDING_STUB = 'virtual:ogygia/client-binding-stub';

/**
 * Fingerprint of a region mark for dedupe. Same component path + same key → one wrapper/entry.
 * @param {{ strategy: string, options?: Record<string, unknown> }} mark
 */
export function strategyKey(mark: { strategy: string; options?: Record<string, unknown> | null }) {
	const o = mark.options || {};
	if (mark.strategy === 'server') {
		let k = `defer:${o.when ?? 'load'}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		if (o.hydrate) {
			k += `+hydrate:${o.hydrate}`;
			if (o.hydrateMargin != null) k += `:hmargin:${o.hydrateMargin}`;
		}
		return k;
	}
	if (mark.strategy === 'lake') {
		let k = `lake:${o.remount || 'cache'}`;
		if (o.when) k += `:when:${o.when}`;
		if (o.maxAgeMs != null) k += `:maxAge:${o.maxAgeMs}`;
		if (o.onExpire) k += `:onExpire:${o.onExpire}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		return k;
	}
	let k = `hydrate:${mark.strategy}`;
	if (o.margin != null) k += `:margin:${o.margin}`;
	return k;
}

/**
 * Cross-host stable identity: posix component path + {@link strategyKey}.
 * Drives region ids so multiple hosts / import sites / `<A />` usages share one module.
 */
export function regionIdentity(
	componentRelPath: string,
	mark: { strategy: string; options?: Record<string, unknown> | null }
) {
	return `${String(componentRelPath).split(/[/\\]/).join('/')}\0${strategyKey(mark)}`;
}

/** Hash an identity string (optional production salt) → 12-char region id. */
export function regionId(identityKey: string, salt = '') {
	const msg = salt ? `${salt}\0${identityKey}` : identityKey;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}

/** True if `val` looks like a CSS media query (must contain a balanced-ish `(…)`). */
function is_media_query(val: string) {
	const open = val.indexOf('(');
	return open !== -1 && val.indexOf(')', open) !== -1;
}

/** Reconstruct an import declaration without its `with { ... }` attributes clause. */
function clean_import_text(source, node) {
	// slice up to the end of the module-specifier string literal, then terminate.
	return source.slice(node.start, node.source.end) + ';';
}

/**
 * Region keys (`hydrate` / `defer` / `preset` under configured names) on a dynamic
 * `import(spec, { with: { … } })` / `{ assert: { … } }` options object.
 * Returns `[]` when the call has no options or no claimed region keys.
 *
 * @param {import('estree').ImportExpression} node
 * @param {ImportKeys} import_keys
 * @returns {string[]}
 */
function region_keys_on_dynamic_import(node, import_keys) {
	const opts = node.options;
	if (!opts || opts.type !== 'ObjectExpression') return [];
	const claimed = new Set([import_keys.hydrate, import_keys.defer, import_keys.preset]);
	/** @type {string[]} */
	const found = [];
	for (const prop of opts.properties) {
		if (prop.type !== 'Property' || prop.computed) continue;
		const bag_key =
			prop.key.type === 'Identifier'
				? prop.key.name
				: prop.key.type === 'Literal'
					? String(prop.key.value)
					: null;
		// Spec uses `with`; older tooling may still emit `assert`.
		if (bag_key !== 'with' && bag_key !== 'assert') continue;
		if (prop.value.type !== 'ObjectExpression') continue;
		for (const atr of prop.value.properties) {
			if (atr.type !== 'Property' || atr.computed) continue;
			const ak =
				atr.key.type === 'Identifier'
					? atr.key.name
					: atr.key.type === 'Literal'
						? String(atr.key.value)
						: null;
			if (ak && claimed.has(ak) && !found.includes(ak)) found.push(ak);
		}
	}
	return found;
}

/**
 * Walk a script Program body for `ImportExpression` nodes carrying ogygia region keys.
 * Dynamic `import()` cannot author islands — SSR shells need a static marked import binding.
 *
 * @param {unknown[]} body
 * @param {ImportKeys} import_keys
 * @param {(keys: string[]) => never} fail
 */
function reject_dynamic_region_imports(body, import_keys, fail) {
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (/** @type {{ type?: string }} */ (node).type === 'ImportExpression') {
			const keys = region_keys_on_dynamic_import(
				/** @type {import('estree').ImportExpression} */ (node),
				import_keys
			);
			if (keys.length) fail(keys);
		}
		for (const k of Object.keys(node)) {
			if (k === 'start' || k === 'end' || k === 'loc') continue;
			const v = /** @type {Record<string, unknown>} */ (node)[k];
			if (Array.isArray(v)) for (const c of v) walk(c);
			else if (v && typeof v === 'object' && typeof /** @type {{ type?: string }} */ (v).type === 'string')
				walk(v);
		}
	};
	for (const n of body ?? []) walk(n);
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

const REMOUNT_SHORTHANDS = new Set(['cache', 'empty', 'swr']);
const REMOUNT_ON_EXPIRE = new Set(['empty', 'fetch']);
/** Schedule keywords shared by `hydrate`, `defer` and `remount.revalidate`. */
const SCHEDULE_KEYWORDS = new Set(['load', 'idle', 'visible']);

/**
 * Parse `remount.maxAge` — number (ms) or duration string (`30s` / `5m` / `1h` / `500ms`).
 * @returns {number | undefined} milliseconds
 */
function parse_max_age(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw) || raw < 0) {
			throw err(names, `\`remount.maxAge\` must be a non-negative number (ms), got ${raw}.`);
		}
		return Math.floor(raw);
	}
	if (typeof raw === 'string') {
		const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
		if (!m) {
			throw err(
				names,
				`unknown remount.maxAge '${raw}'. Use a number (ms) or a duration like '30s' | '5m' | '1h'.`
			);
		}
		const n = Number(m[1]);
		const unit = (m[2] || 'ms').toLowerCase();
		const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
		return Math.floor(n * mult);
	}
	throw err(names, `\`remount.maxAge\` must be a number (ms) or duration string.`);
}

/**
 * Normalize preset `remount`.
 *
 * Shorthands: `'cache'` | `'empty'` | `'swr'` (`swr` ≡ `{ revalidate: 'load' }`).
 * Object: `{ revalidate?: false | schedule, maxAge?, onExpire?: 'empty' | 'fetch' }`.
 *
 * @returns {{ policy: 'cache'|'empty'|'swr', when?: string, maxAgeMs?: number, onExpire?: string } | undefined}
 */
function parse_remount(raw, err, names) {
	if (raw == null) return undefined;
	if (typeof raw === 'string') {
		if (!REMOUNT_SHORTHANDS.has(raw)) {
			throw err(names, `unknown remount '${raw}'. Use 'cache' | 'empty' | 'swr'.`);
		}
		if (raw === 'swr') return { policy: 'swr', when: 'load' };
		return { policy: raw };
	}
	if (typeof raw !== 'object' || raw === null) {
		throw err(
			names,
			`\`remount\` must be 'cache' | 'empty' | 'swr' or \`{ revalidate?, maxAge?, onExpire? }\`.`
		);
	}
	if ('strategy' in raw || 'when' in raw) {
		throw err(
			names,
			`\`remount\` object uses \`revalidate\` (false | 'load' | 'idle' | 'visible' | media), not \`strategy\`/\`when\`. ` +
				`Examples: { revalidate: false, maxAge: '5m' } or { revalidate: 'idle' }. Shorthands: 'cache' | 'empty' | 'swr'.`
		);
	}
	for (const k of Object.keys(raw)) {
		if (k !== 'revalidate' && k !== 'maxAge' && k !== 'onExpire') {
			throw err(names, `unknown remount key '${k}'. Use revalidate, maxAge, onExpire.`);
		}
	}
	if (raw.revalidate == null && raw.maxAge == null && raw.onExpire == null) {
		throw err(
			names,
			`\`remount\` object needs revalidate, maxAge, and/or onExpire — or use the 'cache' | 'empty' | 'swr' shorthand.`
		);
	}

	/** @type {{ policy: string, when?: string, maxAgeMs?: number, onExpire?: string }} */
	const out = { policy: 'cache' };

	if (raw.revalidate === false || raw.revalidate == null) {
		out.policy = 'cache';
	} else if (raw.revalidate === true) {
		throw err(names, `\`remount.revalidate: true\` is invalid — use 'load' (or 'idle' | 'visible' | a media query).`);
	} else {
		const rev = String(raw.revalidate);
		if (!SCHEDULE_KEYWORDS.has(rev) && !is_media_query(rev)) {
			throw err(
				names,
				`unknown remount.revalidate '${rev}'. Use false | 'load' | 'idle' | 'visible' | a media query.`
			);
		}
		out.policy = 'swr';
		out.when = rev;
	}

	if (raw.onExpire != null) {
		const oe = String(raw.onExpire);
		if (!REMOUNT_ON_EXPIRE.has(oe)) {
			throw err(names, `unknown remount.onExpire '${oe}'. Use 'empty' | 'fetch'.`);
		}
		if (out.policy === 'cache' && oe === 'fetch') {
			throw err(
				names,
				`\`onExpire: 'fetch'\` requires \`revalidate\` (a schedule). Pure cache expires to empty — ` +
					`use { revalidate: 'load', maxAge, onExpire: 'fetch' } for SWR past maxAge.`
			);
		}
		out.onExpire = oe;
	}

	if (raw.maxAge != null) {
		out.maxAgeMs = parse_max_age(raw.maxAge, err, names);
	}

	return out;
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
 * @param {(hostPath:string, index:number)=>string} ctx.virtualPathFor virtual module id for an island
 * @returns {TransformResult|null}
 */
export function transformHost(source, id, ctx) {
	const import_keys = normalize_import_keys(ctx.importKeys);
	// cheap bailout — the library only touches region imports (configured key names)
	if (!import_keys_hint(import_keys).test(source)) return null;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instance_body = ast.instance?.content?.body ?? [];
	const module_body = ast.module?.content?.body ?? [];
	const lang = script_lang_attr(ast.instance) || script_lang_attr(ast.module);

	const path = ctx.pathModule;
	// Posix-relative host path — island ids must not drift across Windows/POSIX build legs.
	const rel_host = path.relative(ctx.root, id).split(/[/\\]/).join('/');

	// Dynamic `import(mod, { with: { hydrate|defer|preset } })` is NOT an authoring path.
	// JS/Vite accept the options shape for std attributes (e.g. `type: 'json'`), but:
	//   - Vite strips import attributes from emitted dynamic imports (browser compat),
	//   - runtimes reject unknown keys like `hydrate` if left in place,
	//   - ogygia islands need a static import + a static `<Tag />` so SSR can emit the shell.
	// Fail at transform time with the working alternatives rather than silently no-op.
	reject_dynamic_region_imports(instance_body, import_keys, (keys) => {
		throw new Error(
			`[ogygia] ${rel_host}: dynamic import() with { with: { ${keys.join(', ')} } } is not supported. ` +
				`Mark islands with a static \`import X from '…' with { ${import_keys.hydrate}: '…' }\` ` +
				`(or \`${import_keys.defer}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});
	reject_dynamic_region_imports(module_body, import_keys, (keys) => {
		throw new Error(
			`[ogygia] ${rel_host}: dynamic import() with { with: { ${keys.join(', ')} } } is not supported. ` +
				`Mark islands with a static \`import X from '…' with { ${import_keys.hydrate}: '…' }\` ` +
				`(or \`${import_keys.defer}\` / \`${import_keys.preset}\`) — the binding becomes a portable island component. ` +
				`For a click-loaded chunk that is not an island, use plain \`await import('./Comp.svelte')\` ` +
				`(no region attributes) inside a host island. ` +
				`To delay a real island until click, gate a static region import with \`{#if}\`.`
		);
	});

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

		// Only imports carrying a REGION key are ours. A standard import attribute on an
		// UNRELATED import — `import data from './d.json' with { type: 'json' }`, an
		// `with { type: 'macro' }`, etc. — is left completely untouched (its `with{}` preserved),
		// even in a file that also declares islands. We only validate + strip the imports we claim.
		const IMPORT_KEYS = [import_keys.hydrate, import_keys.defer, import_keys.preset];
		if (!IMPORT_KEYS.some((k) => inline.has(k))) continue;

		// The import block carries hydrate and/or defer, or a preset (under configured names).
		// No option keys inline — all tuning lives in plugin config (ogygia({ presets })).
		/** @type {Map<string,string>} effective attributes (canonical hydrate/defer + margin) */
		let attrs;
		/** @type {{ strategy: string, when?: string } | undefined} */
		let remount_opt;
		let from_preset = null;
		if (inline.has(import_keys.preset)) {
			if (inline.size > 1) {
				throw err(
					names,
					`\`${import_keys.preset}\` must be the only import attribute — put its options (margin, remount, …) in the preset definition (ogygia({ presets })).`
				);
			}
			from_preset = inline.get(import_keys.preset);
			const preset = ctx.presets && ctx.presets[from_preset];
			if (!preset) {
				const avail = Object.keys(ctx.presets || {});
				throw err(
					names,
					`unknown ${import_keys.preset} '${from_preset}'. Available: ${avail.length ? avail.join(', ') : '(none)'}.`
				);
			}
			attrs = new Map();
			for (const [k, v] of Object.entries(preset)) {
				if (v == null) continue;
				if (k === 'remount') {
					remount_opt = parse_remount(v, err, names);
					continue;
				}
				// Preset object keys stay canonical (`hydrate` / `defer` / `margin`).
				attrs.set(k, String(v));
			}
			if (!attrs.has('hydrate') && !attrs.has('defer')) {
				throw err(
					names,
					`${import_keys.preset} '${from_preset}' must set \`hydrate\` or \`defer\` — a margin-only (or empty) preset is a no-op.`
				);
			}
		} else {
			// inline may carry the configured hydrate and/or defer keys (combo = deferred client island)
			for (const k of inline.keys()) {
				if (k !== import_keys.hydrate && k !== import_keys.defer) {
					throw err(
						names,
						`\`${k}\` is not allowed inline. Use \`${import_keys.hydrate}\`, \`${import_keys.defer}\`, or a named \`${import_keys.preset}\` — options like \`margin\` / \`remount\` belong in plugin config (ogygia({ presets })).`
					);
				}
			}
			// Normalize to canonical names for the rest of the pipeline.
			attrs = new Map();
			if (inline.has(import_keys.hydrate)) attrs.set('hydrate', inline.get(import_keys.hydrate));
			if (inline.has(import_keys.defer)) attrs.set('defer', inline.get(import_keys.defer));
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
			throw err(names, `\`remount\` is only valid with \`${import_keys.hydrate}: 'none'\`.`);
		}

		// `hydrate: 'none'` + `defer` is nonsense (HTML later AND no JS) — warn and treat as defer-only.
		if (attrs.has('defer') && attrs.get('hydrate') === 'none') {
			if (ctx.dev) {
				console.warn(
					`[ogygia] ${rel_host}: \`${import_keys.hydrate}: 'none'\` together with \`${import_keys.defer}\` is nonsense — ` +
						`use \`${import_keys.defer}\` alone (HTML later, no JS). Ignoring hydrate; treating as a server island.`
				);
			}
			attrs.delete('hydrate');
		}

		// `defer` -> SERVER island (render: defer). Optional `hydrate` → deferred client island
		// (fetch HTML on defer schedule, then import(entry) + hydrate). Defer VALUE is the
		// fetch-timing: 'load' (immediate, preload-hinted) | 'idle' | 'visible' | a media query.
		// The old boolean spelling `defer: 'true'` is retired — point authors at `defer: 'load'`.
		if (attrs.has('defer')) {
			const dval = attrs.get('defer');
			if (dval === 'true') {
				throw err(
					names,
					`\`${import_keys.defer}: 'true'\` is no longer valid — a server island now takes a fetch-timing value. Use \`${import_keys.defer}: 'load'\` (immediate + preload) | 'idle' | 'visible' | a media query. See DESIGN.md.`
				);
			}
			let when;
			if (KNOWN_STRATEGIES.has(dval)) when = dval; // load | idle | visible
			else if (is_media_query(dval)) when = dval; // media query is the value itself
			else
				throw err(
					names,
					`unknown ${import_keys.defer} timing '${dval}'. Use 'load' | 'idle' | 'visible' | a media query.`
				);

			// `margin` applies to whichever axis is `visible` (tolerantly ignored otherwise).
			const options: {
				when: string;
				margin?: string;
				hydrate?: string;
				hydrateMargin?: string;
			} = { when };
			if (when === 'visible') options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;

			if (attrs.has('hydrate')) {
				const hval = attrs.get('hydrate');
				if (hval === 'false') {
					throw err(
						names,
						`\`${import_keys.hydrate}: 'false'\` is not valid — use \`${import_keys.hydrate}: 'none'\` for a lake (a frozen region inside a hydrated island). See DESIGN.md.`
					);
				}
				let hydrate_strategy;
				if (KNOWN_STRATEGIES.has(hval)) hydrate_strategy = hval;
				else if (is_media_query(hval)) hydrate_strategy = hval;
				else
					throw err(
						names,
						`unknown ${import_keys.hydrate} strategy '${hval}'. Use 'load' | 'idle' | 'visible' | a media query.`
					);
				options.hydrate = hydrate_strategy;
				if (hydrate_strategy === 'visible') {
					options.hydrateMargin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
				}
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy: 'server', options });
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
				/** @type {{ remount?: string, when?: string, margin?: string, maxAgeMs?: number, onExpire?: string }} */
				const lake_opts = {};
				if (remount_opt) {
					lake_opts.remount = remount_opt.policy;
					if (remount_opt.when) lake_opts.when = remount_opt.when;
					if (remount_opt.maxAgeMs != null) lake_opts.maxAgeMs = remount_opt.maxAgeMs;
					if (remount_opt.onExpire) lake_opts.onExpire = remount_opt.onExpire;
					if (remount_opt.policy === 'swr' && remount_opt.when === 'visible') {
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
				throw err(
					names,
					`\`${import_keys.hydrate}: 'false'\` is not valid — use \`${import_keys.hydrate}: 'none'\` for a lake (a frozen region inside a hydrated island). See DESIGN.md.`
				);
			}
			let strategy;
			if (KNOWN_STRATEGIES.has(val)) strategy = val;
			else if (is_media_query(val)) strategy = val; // media query is the value itself
			else
				throw err(
					names,
					`unknown ${import_keys.hydrate} strategy '${val}'. Use 'load' | 'idle' | 'visible' | a media query.`
				);

			// `margin` applies only to `visible` (tolerantly ignored otherwise). Falls back to the
			// plugin-level default ogygia({ visible: { margin } }).
			const options: { margin?: string } = {};
			if (strategy === "visible") {
				options.margin = attrs.get('margin') ?? ctx.visibleMargin ?? undefined;
			}

			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy, options });
			continue;
		}
		// otherwise: a normal import that happens to carry other import attributes — leave it.
	}

	if (marked_components.size === 0) return null;

	const CHILD_KEYS = [
		'consequent',
		'alternate',
		'body',
		'fallback',
		'pending',
		'then',
		'catch',
		'fragment'
	];

	/** Walk AST for Identifier / Component references to `local`. */
	const ast_refs_local = (root, local) => {
		let found = false;
		const walk = (node) => {
			if (found || !node || typeof node !== 'object') return;
			if (node.type === 'Identifier' && node.name === local) {
				found = true;
				return;
			}
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
		for (const n of module_body) {
			if (n.type === 'ImportDeclaration') continue;
			if (ast_refs_local(n, local)) return true;
		}
		return ast_refs_local(ast.fragment?.nodes ?? [], local);
	};

	/** Non-fallback children on a hydrate/defer call site cannot cross devalue — reject. */
	const assert_portable_children = (node, local, is_server) => {
		const kids = (node.fragment?.nodes ?? []).filter(
			(n) => !(n.type === 'Text' && !String(n.data ?? '').trim())
		);
		if (kids.length === 0) return;
		const only_fallback =
			is_server &&
			kids.length === 1 &&
			kids[0].type === 'SnippetBlock' &&
			kids[0].expression?.name === 'ogygiaFallback';
		if (only_fallback) return;
		throw new Error(
			`[ogygia] ${rel_host}: <${local}> has host children/snippets that cannot cross the island boundary. ` +
				`Under portable bindings, pass serializable props and put UI inside the island component` +
				(is_server
					? ` (only the reserved \`{#snippet ogygiaFallback()}\` may appear at the call site).`
					: `.`)
		);
	};

	const visit_usages = (nodes) => {
		for (const node of nodes ?? []) {
			if (node.type === 'Component') {
				const name = node.name || '';
				if (name.includes('.')) {
					const root = name.split('.')[0];
					if (marked_components.has(root) && marked_components.get(root).strategy !== 'lake') {
						throw new Error(
							`[ogygia] ${rel_host}: dotted tag \`<${name}>\` is not supported for region import '${root}'. ` +
								`Import the leaf component with \`with { hydrate|defer }\` instead.`
						);
					}
				} else if (marked_components.has(name)) {
					const mark = marked_components.get(name);
					if (mark.strategy === 'lake') {
						if (mark.options?.remount === 'swr') assert_swr_lake_crossable(node, err);
					} else {
						assert_portable_children(node, name, mark.strategy === 'server');
					}
				}
			}
			for (const k of CHILD_KEYS) if (node[k]?.nodes) visit_usages(node[k].nodes);
			if (node.type === 'Component' && node.fragment?.nodes) visit_usages(node.fragment.nodes);
		}
	};
	visit_usages(ast.fragment?.nodes ?? []);

	const s = new MagicString(source);
	/** @type {Map<string, object>} dedupe by region id within this host */
	const islands_by_id = new Map();
	const salt = ctx.idSalt || '';
	const wrapperPathFor =
		typeof ctx.wrapperPathFor === 'function'
			? ctx.wrapperPathFor
			: (_host, iid) => wrapperVirtualId(iid);

	const posix_rel = (abs) => path.relative(ctx.root, abs).split(/[/\\]/).join('/');

	// Hydrate `emitFile` / `import(entry)` target — JS re-export of the real component.
	// Unique per region id so two strategies sharing one Comp keep distinct entry modules
	// (Rolldown must not content-dedupe them into a facade that drops `export default`).
	// Scale: same path+strategy → one id → one emitFile; N instances share this URL.
	// Wrappers are NOT this entry — they are SSR/csr=true host bindings only.
	const entry_source_for = (componentPath, iid) =>
		`import __OgygiaComp_${iid} from ${JSON.stringify(componentPath)};\n` +
		`export default __OgygiaComp_${iid};\n`;

	const hydrate_wrapper_source = (iid, componentPath, entryPath, strategy, options) => {
		const strategy_attrs = strategy_to_attr(strategy, options);
		const entry_url = ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid);
		return (
			`<script${lang}>\n` +
			`\timport { Island as OgygiaIsland__Wrapper } from 'ogygia/internal';\n` +
			`\timport __OgygiaEntry from ${JSON.stringify(entryPath)};\n` +
			`\timport __OgygiaCss from ${JSON.stringify(componentPath)};\n` +
			`\tlet { children, ...__props } = $props();\n` +
			`</script>\n` +
			`<OgygiaIsland__Wrapper ${strategy_attrs} __entry={${JSON.stringify(entry_url)}} ` +
			`__component={__OgygiaEntry} __css={__OgygiaCss} {__props}>` +
			`{@render children?.()}</OgygiaIsland__Wrapper>\n`
		);
	};

	const server_wrapper_source = (iid, componentPath, entryPath, options) => {
		const deferred_hydrate = !!options?.hydrate;
		const fetch_when = options?.when || 'load';
		let server_attrs = `__defer={${JSON.stringify(fetch_when)}}`;
		if (options?.margin != null) server_attrs += ` __margin={${JSON.stringify(options.margin)}}`;
		if (deferred_hydrate) {
			const module_url = ctx.dev ? ctx.devUrlFor(entryPath) : islandPublicUrl(iid);
			server_attrs += ` __hydrate={${JSON.stringify(options.hydrate)}}`;
			server_attrs += ` __module={${JSON.stringify(module_url)}}`;
			if (options.hydrateMargin != null) {
				server_attrs += ` __hydrateMargin={${JSON.stringify(options.hydrateMargin)}}`;
			}
		}
		return (
			`<script${lang}>\n` +
			`\timport { ServerIsland as OgygiaServerIsland__Wrapper } from 'ogygia/internal/server';\n` +
			`\timport __OgygiaEntry from ${JSON.stringify(entryPath)};\n` +
			`\timport __OgygiaCss from ${JSON.stringify(componentPath)};\n` +
			`\tlet { ogygiaFallback, ...__props } = $props();\n` +
			`</script>\n` +
			`<OgygiaServerIsland__Wrapper __entry={${JSON.stringify(iid)}} __component={__OgygiaEntry} ` +
			`__css={__OgygiaCss} {__props} ${server_attrs} {ogygiaFallback} />\n`
		);
	};

	const lake_wrapper_source = (iid, componentPath, options) => {
		const remount = options?.remount || 'cache';
		const needs_endpoint = remount === 'swr';
		const when = options?.when || (needs_endpoint ? 'load' : undefined);
		let attrs =
			`__entry={${JSON.stringify(iid)}} __remount={${JSON.stringify(remount)}}`;
		if (options?.maxAgeMs != null) attrs += ` __maxAge={${JSON.stringify(options.maxAgeMs)}}`;
		if (options?.onExpire) attrs += ` __onExpire={${JSON.stringify(options.onExpire)}}`;
		if (needs_endpoint) {
			attrs += ` __when={${JSON.stringify(when || 'load')}} __props={__props}`;
			if (options?.margin != null) attrs += ` __margin={${JSON.stringify(options.margin)}}`;
		}
		// Static `<OgygiaLakeInner>` (not dynamic) preserves LAKE-ENVELOPE. Client build swaps
		// that import for LakePlaceholder. LakeRegion itself degrades in the shell (!isNested).
		return (
			`<script${lang}>\n` +
			`\timport { LakeRegion as OgygiaLakeRegion__Wrapper } from 'ogygia/internal';\n` +
			`\timport OgygiaLakeInner from ${JSON.stringify(componentPath)};\n` +
			`\tlet __props = $props();\n` +
			`</script>\n` +
			`<OgygiaLakeRegion__Wrapper ${attrs}>` +
			`<OgygiaLakeInner {...__props} /></OgygiaLakeRegion__Wrapper>\n`
		);
	};

	// Portable binding target for this compile:
	//   - SSR / csr=true client → real wrapper (Island shell + __component link)
	//   - csr=false client → stub (page node must not pull N wrappers into the client graph;
	//     emitFile owns hydrate entries; runtime loads via import(entry))
	const link_virtual = ctx.linkVirtualIsland !== false;
	const binding_stub =
		typeof ctx.clientBindingStub === 'string' && ctx.clientBindingStub
			? ctx.clientBindingStub
			: CLIENT_BINDING_STUB;

	// Rewrite each marked import binding → wrapper or stub (islands still deduped by identity).
	const rewritten_import_nodes = new Set();
	/** Entry module specs already emitted as side-effect CSS imports on this host. */
	const fouc_css_specs = new Set();

	/**
	 * csr=false CLIENT: stub replaces the portable wrapper binding, but Kit only links CSS from
	 * the *client* page graph. Side-effect-import `virtual:ogygia/fouc-css/<entry>` (CSS graph
	 * only — not the component JS) so stylesheets still ship without dual-owning the module
	 * that emitFile registers as `ogygia-island.*`.
	 */
	const binding_rewrite = (local, bindingPath, componentPathAbs) => {
		let text = `import ${local} from ${JSON.stringify(bindingPath)};`;
		if (
			!link_virtual &&
			typeof componentPathAbs === 'string' &&
			componentPathAbs &&
			!fouc_css_specs.has(componentPathAbs)
		) {
			fouc_css_specs.add(componentPathAbs);
			const rel = posix_rel(componentPathAbs);
			text += `\nimport ${JSON.stringify(foucCssVirtualId(rel))};`;
		}
		return text;
	};
	for (const [local, mark] of marked_components) {
		const info = imports.get(local);
		if (!info) continue;

		if (!marked_import_referenced(local)) {
			// Unused marked import — strip entirely (dead code).
			if (!rewritten_import_nodes.has(info.node)) {
				imports_to_strip.add(info.node);
			}
			continue;
		}

		const entry_spec = info.node.source?.value;
		const componentPath = resolve_component_path(entry_spec, id, ctx);
		if (!componentPath) {
			throw new Error(
				`[ogygia] ${rel_host}: region import '${local}' needs a resolvable module path ($lib/… or relative).`
			);
		}
		const comp_rel = posix_rel(componentPath);
		const identity = regionIdentity(comp_rel, mark);
		const iid = regionId(identity, salt);
		const entryPath = ctx.virtualPathFor(id, iid);
		const wrapPath = wrapperPathFor(id, iid);
		const bindingPath = link_virtual ? wrapPath : binding_stub;

		if (mark.strategy === 'lake') {
			if (!islands_by_id.has(iid)) {
				const remount = mark.options?.remount || 'cache';
				const swr = remount === 'swr';
				islands_by_id.set(iid, {
					id: iid,
					// SWR lakes need a server-renderable entry; cache/empty are wrapper-only.
					virtualPath: swr ? entryPath : undefined,
					source: swr ? entry_source_for(componentPath, iid) : undefined,
					wrapperPath: wrapPath,
					wrapperSource: lake_wrapper_source(iid, componentPath, mark.options),
					hostPath: id,
					componentPath,
					server: swr,
					kind: 'lake',
					lakes: ['OgygiaLakeInner'],
					identity
				});
			}
			if (!rewritten_import_nodes.has(info.node)) {
				s.overwrite(
					info.node.start,
					info.node.end,
					binding_rewrite(local, bindingPath, componentPath)
				);
				rewritten_import_nodes.add(info.node);
			}
			continue;
		}

		const is_server = mark.strategy === 'server';
		const deferred_hydrate = is_server && !!mark.options?.hydrate;
		if (!islands_by_id.has(iid)) {
			const entry_src = entry_source_for(componentPath, iid);
			const wrapper_src = is_server
				? server_wrapper_source(iid, componentPath, entryPath, mark.options)
				: hydrate_wrapper_source(iid, componentPath, entryPath, mark.strategy, mark.options);
			islands_by_id.set(iid, {
				id: iid,
				virtualPath: entryPath,
				wrapperPath: wrapPath,
				wrapperSource: wrapper_src,
				source: entry_src,
				hostPath: id,
				componentPath,
				server: is_server,
				kind: is_server ? (deferred_hydrate ? 'hydrate' : 'defer') : 'hydrate',
				lakes: [],
				identity
			});
		}

		if (!rewritten_import_nodes.has(info.node)) {
			// One ImportDeclaration may have multiple specifiers — only default-import style is supported.
			const specs = info.node.specifiers ?? [];
			if (specs.length !== 1 || specs[0].type !== 'ImportDefaultSpecifier') {
				throw err(
					local,
					`region imports must be a default import (\`import X from '…' with { … }\`).`
				);
			}
			s.overwrite(
				info.node.start,
				info.node.end,
				binding_rewrite(local, bindingPath, componentPath)
			);
			rewritten_import_nodes.add(info.node);
		}
	}

	for (const node of imports_to_strip) {
		if (rewritten_import_nodes.has(node)) continue;
		s.remove(node.start, node.end);
	}

	return {
		code: s.toString(),
		map: s.generateMap({ hires: true, source: id, includeContent: true }),
		islands: [...islands_by_id.values()]
	};
}
