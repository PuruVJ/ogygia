import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { createHash } from 'node:crypto';
import { collectFreeIdentifiers, collectSnippetNames } from './free-vars.js';

export const ISLAND_DIR = '.sk-islands';

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

function isGlobal(name) {
	if (GLOBAL_ALLOW.has(name)) return true;
	try {
		return name in globalThis;
	} catch {
		return false;
	}
}

/** Reconstruct an import declaration without its `with { ... }` attributes clause. */
function cleanImportText(source, node) {
	// slice up to the end of the module-specifier string literal, then terminate.
	return source.slice(node.start, node.source.end) + ';';
}

function scriptLangAttr(scriptNode) {
	if (!scriptNode) return '';
	for (const attr of scriptNode.attributes ?? []) {
		if (attr.name === 'lang' && Array.isArray(attr.value) && attr.value[0]?.data) {
			return ` lang="${attr.value[0].data}"`;
		}
	}
	return '';
}

/** Map a strategy string to the Island wrapper attribute markup. */
function strategyToAttr(strategy) {
	if (!strategy || strategy === 'load') return 'load';
	if (strategy === 'visible') return 'visible';
	if (strategy === 'idle') return 'idle';
	// treat anything else (contains a paren/colon) as a media query
	return `media=${JSON.stringify(strategy)}`;
}

/**
 * @typedef {Object} TransformResult
 * @property {string} code rewritten host source
 * @property {any} map source map
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
	// cheap bailout
	if (!/island/i.test(source)) return null;

	let ast;
	try {
		ast = parse(source, { modern: true, filename: id });
	} catch {
		return null;
	}

	const instanceBody = ast.instance?.content?.body ?? [];
	const lang = scriptLangAttr(ast.instance) || scriptLangAttr(ast.module);

	// --- collect host imports & island marks -------------------------------
	// The ONLY authoring syntax is the import attribute:
	//   import Comp from './Comp.svelte' with { island: 'visible' };
	/** localName -> { node, cleaned } */
	const imports = new Map();
	/** localName -> strategy */
	const markedComponents = new Map();
	const importsToStrip = new Set(); // ImportDeclaration nodes to remove from host

	const path = ctx.pathModule;

	for (const node of instanceBody) {
		if (node.type !== 'ImportDeclaration') continue;
		const cleaned = cleanImportText(source, node);

		const islandAttr = (node.attributes ?? []).find(
			(a) => a.type === 'ImportAttribute' && a.key.name === 'island'
		);
		if (islandAttr) {
			const markStrategy = String(islandAttr.value.value);
			for (const spec of node.specifiers) {
				markedComponents.set(spec.local.name, markStrategy);
			}
			importsToStrip.add(node);
		}

		for (const spec of node.specifiers) {
			imports.set(spec.local.name, { node, cleaned });
		}
	}

	// host top-level snippet names (for cross-boundary error detection)
	const hostSnippetNames = collectSnippetNames(ast.fragment?.nodes ?? []);

	// --- find island units in the template ---------------------------------
	/** @type {Array<{node:any, strategy:string}>} marked-component usages */
	const units = [];
	/** @type {any[]} nested `<script island>` elements to bundle */
	const scriptUnits = [];
	const hasIslandAttr = (node) =>
		(node.attributes ?? []).some((a) => a.type === 'Attribute' && a.name === 'island');
	const visit = (nodes) => {
		for (const node of nodes ?? []) {
			if (node.type === 'Component' && markedComponents.has(node.name)) {
				units.push({ node, strategy: markedComponents.get(node.name) });
				continue; // do not descend
			}
			if (node.type === 'RegularElement' && node.name === 'script' && hasIslandAttr(node)) {
				scriptUnits.push(node);
				continue; // do not descend
			}
			// descend into child fragments
			for (const k of ['consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch', 'fragment']) {
				if (node[k]?.nodes) visit(node[k].nodes);
			}
		}
	};
	visit(ast.fragment?.nodes ?? []);

	if (units.length === 0 && scriptUnits.length === 0 && importsToStrip.size === 0) return null;

	const s = new MagicString(source);
	const islands = [];
	const relHost = path.relative(ctx.root, id);
	const preambleImports = [];
	// The transform emits a private wrapper component (not a public API). Component
	// tags must start uppercase or Svelte parses them as plain HTML elements.
	const wrapperName = 'SkIsland__Wrapper';
	const serverWrapperName = 'SkServerIsland__Wrapper';
	let wrapperImported = false;
	let serverWrapperImported = false;

	/** Find a reserved `{#snippet fallback()}` block among a component's children. */
	const findFallbackSnippet = (node) => {
		for (const child of node.fragment?.nodes ?? []) {
			if (child.type === 'SnippetBlock' && child.expression?.name === 'fallback') return child;
		}
		return null;
	};

	units.forEach((unit, index) => {
		const iid = islandId(relHost, index);
		const virtualPath = ctx.virtualPathFor(id, iid);
		const compVar = `__SkIsland_${index}`;
		const isServer = unit.strategy === 'server';

		// SERVER island: the reserved `fallback` snippet renders into the page immediately
		// (kept in host scope, so it can reference host vars directly). The island component
		// itself is hoisted WITHOUT the fallback and rendered only by the `/_islands` endpoint.
		const fallbackNode = isServer ? findFallbackSnippet(unit.node) : null;

		// The subtree we hoist + analyse for free vars. For server islands, strip the fallback.
		let hoistedSource;
		let subtreeNodes;
		if (fallbackNode) {
			hoistedSource =
				source.slice(unit.node.start, fallbackNode.start) +
				source.slice(fallbackNode.end, unit.node.end);
			// shallow-clone the component node with the fallback snippet removed for analysis
			const filtered = {
				...unit.node,
				fragment: {
					...unit.node.fragment,
					nodes: unit.node.fragment.nodes.filter((n) => n !== fallbackNode)
				}
			};
			subtreeNodes = [filtered];
		} else {
			hoistedSource = source.slice(unit.node.start, unit.node.end);
			subtreeNodes = [unit.node];
		}

		// free-variable analysis
		const free = collectFreeIdentifiers(subtreeNodes);
		const usedImportNodes = new Set();
		const captured = [];
		for (const name of free) {
			if (imports.has(name)) {
				usedImportNodes.add(imports.get(name).node);
			} else if (isGlobal(name)) {
				// leave alone
			} else if (hostSnippetNames.has(name)) {
				throw new Error(
					`[sk-islands] ${relHost}: island references snippet \`${name}\` defined outside the island. ` +
						`Snippets cannot cross the island boundary. Define the snippet inside the island instead.`
				);
			} else {
				captured.push(name);
			}
		}

		// build virtual island module source: gather cleaned text per used import node
		const copiedImports = [];
		for (const [, info] of imports) {
			if (usedImportNodes.has(info.node) && !copiedImports.includes(info.cleaned)) {
				copiedImports.push(info.cleaned);
			}
		}

		const propsLine = captured.length ? `\tlet { ${captured.join(', ')} } = $props();` : '';
		const scriptBody = [...copiedImports.map((l) => '\t' + l), propsLine]
			.filter(Boolean)
			.join('\n');
		const virtualSource = `<script${lang}>\n${scriptBody}\n</script>\n${hoistedSource}\n`;

		islands.push({ id: iid, virtualPath, source: virtualSource, hostPath: id, server: isServer });

		const propsObj = captured.length ? `{ ${captured.join(', ')} }` : '{}';

		if (isServer) {
			if (!serverWrapperImported) {
				serverWrapperImported = true;
				preambleImports.push(
					`\timport { ServerIsland as ${serverWrapperName} } from 'sk-islands/internal';`
				);
			}
			// Keep a host import of the island component so its CSS is collected via the
			// PAGE's (SSR) import graph and linked into the page <head>. The wrapper never
			// renders it (the /_islands endpoint resolves it by id) — passing it as an
			// ignored `__component` prop just keeps the import from being tree-shaken.
			// On a csr=false page (the supported config) this ships zero client JS.
			preambleImports.push(`\timport ${compVar} from ${JSON.stringify(virtualPath)};`);
			const fallbackText = fallbackNode
				? source.slice(fallbackNode.start, fallbackNode.end)
				: '';
			const replacement =
				`<${serverWrapperName} __entry={${JSON.stringify(iid)}} ` +
				`__component={${compVar}} __props={${propsObj}}>` +
				fallbackText +
				`</${serverWrapperName}>`;
			s.overwrite(unit.node.start, unit.node.end, replacement);
			return;
		}

		if (!wrapperImported) {
			wrapperImported = true;
			preambleImports.push(`\timport { Island as ${wrapperName} } from 'sk-islands/internal';`);
		}

		// rewrite host: replace the unit with an <Island> wrapper element
		const strategyAttrsText = strategyToAttr(unit.strategy);
		// dev: __entry is the vite dev URL of the island module; build: the manifest key (iid)
		const entryValue = ctx.dev ? ctx.devUrlFor(virtualPath) : iid;
		const replacement =
			`<${wrapperName} ${strategyAttrsText} ` +
			`__entry={${JSON.stringify(entryValue)}} __component={${compVar}} __props={${propsObj}} />`;
		s.overwrite(unit.node.start, unit.node.end, replacement);

		preambleImports.push(`\timport ${compVar} from ${JSON.stringify(virtualPath)};`);
	});

	// --- bundled `<script island>` -> its own module chunk -----------------
	const scripts = [];
	scriptUnits.forEach((node, i) => {
		const hash = islandId(relHost, 1000 + i); // distinct id space from islands
		const isTs = (node.attributes ?? []).some(
			(a) => a.type === 'Attribute' && a.name === 'lang'
		);
		const ext = isTs ? '.ts' : '.js';
		const scriptPath = ctx.scriptPathFor(id, hash, ext);
		const kids = node.fragment?.nodes ?? [];
		const inner = kids.length ? source.slice(kids[0].start, kids[kids.length - 1].end) : '';
		const url = ctx.scriptUrlFor(scriptPath, hash);
		scripts.push({ scriptPath, source: inner, hostPath: id, hash });
		s.overwrite(
			node.start,
			node.end,
			`<script type="module" src=${JSON.stringify(url)}></script>`
		);
	});

	// strip island-marked imports (their `with{}` clause & now-unused binding)
	for (const node of importsToStrip) {
		s.remove(node.start, node.end);
	}

	// inject island component imports into the instance <script>
	if (preambleImports.length) {
		if (ast.instance) {
			// insert right after the opening <script ...> tag
			const openTagEnd = source.indexOf('>', ast.instance.start) + 1;
			s.appendLeft(openTagEnd, '\n' + preambleImports.join('\n'));
		} else {
			// no instance script; create one
			s.prepend(`<script${lang}>\n${preambleImports.join('\n')}\n</script>\n`);
		}
	}

	return { code: s.toString(), map: s.generateMap({ hires: true }), islands, scripts };
}
