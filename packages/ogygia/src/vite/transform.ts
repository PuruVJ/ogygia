import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { collectCaptureInfo, collectSnippetNames } from './free-vars.js';

export const ISLAND_DIR = '.ogygia';

/** Deterministic short id for an island (stable across dev + build). */
export function islandId(relHostPath, index) {
	return createHash('md5').update(`${relHostPath}::${index}`).digest('hex').slice(0, 12);
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
	if (!/hydrate|defer|preset/.test(source)) return null;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instance_body = ast.instance?.content?.body ?? [];
	const lang = script_lang_attr(ast.instance) || script_lang_attr(ast.module);

	const path = ctx.pathModule;
	const rel_host = path.relative(ctx.root, id);

	// --- collect host imports & region marks (the two-key region model) --------
	// The authoring syntax is the import attribute, one concern per key:
	//   import Comp from './Comp.svelte' with { hydrate: 'visible', margin: '200px' };
	//   import Comp from './Comp.svelte' with { hydrate: '(min-width: 768px)' };
	//   import Comp from './Comp.svelte' with { defer: 'true' };   // server island
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

		// The import block carries EXACTLY ONE of `hydrate` | `defer` | `preset`. No option keys
		// inline — all tuning (margin, …) lives in plugin config (ogygia({ visible, presets })).
		/** @type {Map<string,string>} effective attributes (from a preset, or the single inline key) */
		let attrs;
		let from_preset = null;
		if (inline.has('preset')) {
			if (inline.size > 1) {
				throw err(names, '`preset` must be the only import attribute — put its options (margin, …) in the preset definition (ogygia({ presets })).');
			}
			from_preset = inline.get('preset');
			const preset = ctx.presets && ctx.presets[from_preset];
			if (!preset) {
				const avail = Object.keys(ctx.presets || {});
				throw err(names, `unknown preset '${from_preset}'. Available: ${avail.length ? avail.join(', ') : '(none)'}.`);
			}
			attrs = new Map();
			for (const [k, v] of Object.entries(preset)) if (v != null) attrs.set(k, String(v));
		} else {
			// inline may carry only `hydrate` or `defer` (the hydrate+defer pair is a roadmap error below)
			for (const k of inline.keys()) {
				if (k !== 'hydrate' && k !== 'defer') {
					throw err(
						names,
						`\`${k}\` is not allowed inline. Use \`hydrate\`, \`defer\`, or a named \`preset\` — options like \`margin\` belong in plugin config (ogygia({ visible, presets })).`
					);
				}
			}
			attrs = inline;
		}

		// Only UNKNOWN keys are errors. Presets are TOLERANT: a known-but-inapplicable key
		// (e.g. `margin` with `hydrate: 'load'`) is silently ignored — it applies wherever it's
		// relevant. `margin` never reaches here inline (rejected above), so this only bites typos.
		const SCHEMA = new Set(['hydrate', 'defer', 'margin']);
		for (const k of attrs.keys()) {
			if (!SCHEMA.has(k)) {
				throw err(names, from_preset ? `unknown key \`${k}\` in preset '${from_preset}'.` : `unknown import attribute \`${k}\`.`);
			}
		}
		if (attrs.get('defer') === 'true' && attrs.has('hydrate')) {
			throw err(names, "`defer` + `hydrate` together is not yet supported (roadmap: deferred client island — see DESIGN.md).");
		}

		// `defer: 'true'` -> server island (render: defer, hydrate: false). `margin` ignored.
		if (attrs.get('defer') === 'true') {
			for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy: 'server', options: {} });
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
				for (const spec of node.specifiers) marked_components.set(spec.local.name, { strategy: 'lake', options: {} });
				continue;
			}
			if (val === 'false') {
				// Import-attribute values are strings; the "no hydration" value is the WORD 'none'
				// (not the boolean-looking 'false'). No silent alias — point the author at 'none'.
				throw err(names, "`hydrate: 'false'` is not valid — use `hydrate: 'none'` for a lake (a frozen region inside a hydrated island). See DESIGN.md.");
			}
			let strategy;
			if (KNOWN_STRATEGIES.has(val)) strategy = val;
			else if (val.includes('(')) strategy = val; // media query is the value itself
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
				`[ogygia] ${rel_host}: <${name}> has \`hydrate: 'false'\` (lake) in the page shell — that is a no-op (the shell is already dead). A lake only has meaning INSIDE a hydrated island. Rendering it as a plain component.`
			);
		}
	}

	if (units.length === 0 && imports_to_strip.size === 0 && shell_lake_locals.size === 0) return null;

	const s = new MagicString(source);
	const islands = [];
	// LAKE local names hoisted into some island (their host import is now unused -> stripped).
	const island_lake_locals = new Set();
	// LAKE region ids (metadata-only entries for the client `regions` manifest — kind:'lake', no
	// load thunk, so the lake component's JS is never pulled into the client graph).
	const lake_region_ids = [];
	const preamble_imports = [];
	// The transform emits a private wrapper component (not a public API). Component
	// tags must start uppercase or Svelte parses them as plain HTML elements.
	const wrapper_name = 'OgygiaIsland__Wrapper';
	const server_wrapper_name = 'OgygiaServerIsland__Wrapper';
	let wrapper_imported = false;
	let server_wrapper_imported = false;

	/** Find a reserved `{#snippet fallback()}` block among a component's children. */
	const find_fallback_snippet = (node) => {
		for (const child of node.fragment?.nodes ?? []) {
			if (child.type === 'SnippetBlock' && child.expression?.name === 'fallback') return child;
		}
		return null;
	};

	units.forEach((unit, index) => {
		const iid = islandId(rel_host, index);
		const virtualPath = ctx.virtualPathFor(id, iid);
		const comp_var = `__OgygiaIsland_${index}`;
		const is_server = unit.strategy === 'server';

		// SERVER island: the reserved `fallback` snippet renders into the page immediately
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

		// LAKES: a `hydrate: 'false'` component used inside THIS (client) island. Wrap each in a
		// non-boundary `<ogygia-region data-lake>` so the runtime can lift/restore its SSR DOM
		// around hydration; record the local so the client build swaps its import for a placeholder
		// (the lake's JS ships in no client chunk). SSR keeps the real component (rendered inline).
		const island_lakes = [];
		if (!is_server) {
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
					const lake_id = islandId(rel_host, `lake:${index}:${li}`);
					// Wrap in `<OgygiaLakeBoundary>` so the lake's subtree resets the nested-island
					// context (an island authored inside the lake self-hydrates). The non-boundary
					// `<ogygia-region data-lake>` lets the runtime lift/restore the frozen DOM.
					lake_ms.appendLeft(ln.start, `<ogygia-region data-lake entry=${JSON.stringify(lake_id)}><OgygiaLakeBoundary>`);
					lake_ms.appendRight(ln.end, `</OgygiaLakeBoundary></ogygia-region>`);
					island_lakes.push(ln.name);
					island_lake_locals.add(ln.name);
					lake_region_ids.push(lake_id);
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
			} else if (is_global(name)) {
				// leave alone
			} else if (host_snippet_names.has(name)) {
				throw new Error(
					`[ogygia] ${rel_host}: island references snippet \`${name}\` defined outside the island. ` +
						`Snippets cannot cross the island boundary. Define the snippet inside the island instead.`
				);
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
			// the lake wrapper component (resets nested-island context around frozen subtrees)
			copied_imports.push(`import { LakeBoundary as OgygiaLakeBoundary } from 'ogygia/internal';`);
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

		islands.push({
			id: iid,
			virtualPath,
			source: virtual_source,
			hostPath: id,
			server: is_server,
			kind: is_server ? 'defer' : 'hydrate',
			lakes: island_lakes
		});

		const props_obj = captured.length ? `{ ${captured.join(', ')} }` : '{}';

		if (is_server) {
			if (!server_wrapper_imported) {
				server_wrapper_imported = true;
				preamble_imports.push(
					`\timport { ServerIsland as ${server_wrapper_name} } from 'ogygia/internal';`
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
			const replacement =
				`<${server_wrapper_name} __entry={${JSON.stringify(iid)}} ` +
				`__component={${comp_var}} __props={${props_obj}}>` +
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

	// Register lake regions as metadata-only client-manifest entries (kind:'lake', no module) so
	// the runtime can consult ONE uniform `regions` record — a lake never gets a load thunk.
	for (const lake_id of lake_region_ids) {
		islands.push({ id: lake_id, kind: 'lake' });
	}

	// LAKE host imports: a lake hoisted into an island leaves its host import unused -> strip it
	// (with the `with{}` clause). A shell-only lake (no-op) keeps a CLEANED import (drop `with{}`)
	// so it renders as a plain component. Both must lose the `with{}` clause (an invalid runtime
	// import attribute). Decide per lake local before the strip loop runs.
	for (const [local, mark] of marked_components) {
		if (mark.strategy !== 'lake') continue;
		const info = imports.get(local);
		if (!info || imports_to_strip.has(info.node)) continue;
		if (island_lake_locals.has(local) && !shell_lake_locals.has(local)) {
			imports_to_strip.add(info.node); // hoisted only -> remove entirely
		} else {
			s.overwrite(info.node.start, info.node.end, info.cleaned); // shell use -> keep, drop with{}
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
