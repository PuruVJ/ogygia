/**
 * Console value formatting for the Observatory's preview console — a readable, type-aware `inspect` in the
 * spirit of Node's util.inspect / the browser console (and svelte.dev's REPL): strings are raw at the top
 * level but quoted when nested, and every other kind renders with its shape/type (Date, RegExp, Map, Set,
 * TypedArray, function, symbol, bigint, Error, class instances, DOM nodes, circular refs, depth cap).
 * Pure + dependency-free so it's unit-testable off-DOM.
 */

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 5;
const MAX_ITEMS = 100; // don't render a million-element array inline
const MAX_STRING = 800;

function q(s: string): string {
	const str = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '…' : s;
	return JSON.stringify(str);
}

/** Format ONE value with strings QUOTED (the nested form). */
export function inspect(v: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): string {
	switch (typeof v) {
		case 'string':
			return q(v);
		case 'number':
			return Object.is(v, -0) ? '-0' : String(v);
		case 'boolean':
			return String(v);
		case 'bigint':
			return String(v) + 'n';
		case 'symbol':
			return v.toString();
		case 'undefined':
			return 'undefined';
		case 'function': {
			const name = (v as { name?: string }).name;
			const kind = /^class[\s{]/.test(Function.prototype.toString.call(v)) ? 'class' : 'ƒ';
			return `${kind} ${name || '(anonymous)'}`;
		}
	}
	if (v === null) return 'null';
	const obj = v as object;

	if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
	if (v instanceof RegExp) return v.toString();
	if (v instanceof Error) return v.stack ? `${v.name}: ${v.message}` : `${v.name}: ${v.message}`;
	// DOM node (guarded — no DOM in node tests)
	const node = v as { nodeType?: number; tagName?: string; nodeName?: string; textContent?: string };
	if (typeof node.nodeType === 'number') {
		if (node.tagName) return `<${node.tagName.toLowerCase()}>`;
		if (node.nodeType === 3) return `#text "${(node.textContent || '').slice(0, 30)}"`;
		return `#node(${node.nodeName ?? node.nodeType})`;
	}

	if (seen.has(obj)) return '[Circular]';
	if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[…]' : '{…}';
	seen.add(obj);
	try {
		if (Array.isArray(v)) {
			if (v.length === 0) return '[]';
			const items = v.slice(0, MAX_ITEMS).map((x) => inspect(x, seen, depth + 1));
			if (v.length > MAX_ITEMS) items.push(`… ${v.length - MAX_ITEMS} more`);
			return '[ ' + items.join(', ') + ' ]';
		}
		if (v instanceof Map) {
			if (v.size === 0) return 'Map(0) {}';
			const items = [...v].slice(0, MAX_ITEMS).map(([k, val]) => `${inspect(k, seen, depth + 1)} => ${inspect(val, seen, depth + 1)}`);
			return `Map(${v.size}) { ` + items.join(', ') + ' }';
		}
		if (v instanceof Set) {
			if (v.size === 0) return 'Set(0) {}';
			const items = [...v].slice(0, MAX_ITEMS).map((x) => inspect(x, seen, depth + 1));
			return `Set(${v.size}) { ` + items.join(', ') + ' }';
		}
		if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
			const ta = v as unknown as { length: number; constructor: { name: string }; [i: number]: number };
			const items = Array.from({ length: Math.min(ta.length, MAX_ITEMS) }, (_, i) => String(ta[i]));
			return `${ta.constructor.name}(${ta.length}) [ ${items.join(', ')}${ta.length > MAX_ITEMS ? ', …' : ''} ]`;
		}
		if (v instanceof Promise) return 'Promise';
		// plain object / class instance
		const ctor = (obj as { constructor?: { name?: string } }).constructor;
		const name = ctor?.name;
		const prefix = name && name !== 'Object' ? name + ' ' : '';
		const keys = Object.keys(obj);
		if (keys.length === 0) return prefix ? prefix + '{}' : '{}';
		const shown = keys.slice(0, MAX_ITEMS);
		const body = shown.map((k) => `${IDENT.test(k) ? k : q(k)}: ${inspect((obj as Record<string, unknown>)[k], seen, depth + 1)}`);
		if (keys.length > MAX_ITEMS) body.push(`… ${keys.length - MAX_ITEMS} more`);
		return prefix + '{ ' + body.join(', ') + ' }';
	} catch {
		return String(v);
	} finally {
		seen.delete(obj);
	}
}

/** Format a `console.*(...)` argument list into one line: top-level strings raw, everything else inspected. */
export function format_console_args(args: unknown[]): string {
	return args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
}
