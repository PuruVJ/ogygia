/**
 * Boundary classifier — guard layer of the transportable seam.
 *
 * When a context/prop value heads for an island boundary, this walks it and names, per leaf,
 * what will happen: cross free, auto-wire, warn, or refuse — WITH the path to the leaf. It
 * exists so a value that can't cross fails at BOUNDARY DISCOVERY with "context 'user' @
 * profile.avatarEl: live DOM node", instead of an island silently reading `undefined` in prod.
 *
 * Dev-only caller today: `serialize_provided_context` used to drop unbridgeable keys silently;
 * it now explains each drop. The classifier is pure and dependency-light (store detection is
 * by shape, DOM by nodeType) so it costs nothing to import server-side.
 */

import { is_store, is_derived_like } from './store-transport.js';
import { wire } from './live-transport.js';

export interface BoundaryFinding {
	/** What the seam will do with this leaf. */
	kind: 'plain' | 'wire' | 'store' | 'warn' | 'refuse';
	/** Dot-path from the context value to the leaf (empty = the value itself). */
	path: string;
	/** One human sentence: what it is + what to do about it. */
	detail: string;
}

const SECRET_KEY_RE = /token|secret|passw(or)?d|api[-_]?key|credential|authorization/i;

/** App-configurable secret policy (call once in hooks.server.ts). `allow` names keys/paths the
 *  sniff must NOT refuse (a false positive like 'tokenColor'); `deny` names ones it MUST refuse
 *  even when the regex misses (a semantic secret the shape can't reveal). Exact, case-sensitive
 *  matches against the context key or the finding path. */
export interface BoundaryPolicy {
	allow?: readonly string[];
	deny?: readonly string[];
}
let policy: { allow: Set<string>; deny: Set<string> } = { allow: new Set(), deny: new Set() };
export function configure_boundary(p: BoundaryPolicy): void {
	policy = { allow: new Set(p.allow ?? []), deny: new Set(p.deny ?? []) };
}
const secret_like = (name: string): boolean =>
	!policy.allow.has(name) && (policy.deny.has(name) || SECRET_KEY_RE.test(name));

const STORE_BUILTINS = new Set(['subscribe', 'set', 'update']);

function is_dom(v: object): boolean {
	return typeof (v as { nodeType?: unknown }).nodeType === 'number' && typeof (v as { nodeName?: unknown }).nodeName === 'string';
}

function is_plain_object(v: object): boolean {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * Classify one boundary value. `key` is the context key / prop name (used for secret sniffing
 * and in messages). Returns every finding, worst problems included — the caller decides
 * whether to warn (dev) or refuse (encode).
 */
export function classify_boundary(value: unknown, key = ''): BoundaryFinding[] {
	const findings: BoundaryFinding[] = [];
	const seen = new Set<object>();
	const add = (kind: BoundaryFinding['kind'], path: string, detail: string) =>
		findings.push({ kind, path, detail });

	if (secret_like(key) && typeof value === 'string') {
		add('refuse', '', `key "${key}" looks like a secret — refusing to ship it into client-island HTML`);
	}

	(function walk(v: unknown, path: string): void {
		if (v === null || typeof v !== 'object') {
			if (typeof v === 'function') {
				add(
					'refuse',
					path,
					'a bare function cannot cross an island boundary — make it a method on a [og.wire] class, a remote function, or provide it from an island'
				);
			} else if (typeof v === 'string' && path && secret_like(path.split('.').pop() ?? path)) {
				add('warn', path, 'secret-looking field crossing into client HTML — check this is not a credential');
			}
			return;
		}
		if (is_dom(v)) {
			add('refuse', path, 'live DOM node — it only exists in this document; provide it from an island (same-heap) instead');
			return;
		}
		// Revisit = cycle. Devalue serializes plain-object cycles natively, so a cycle is only a
		// problem when it rides a CLASS instance — and the non-plain-object check below catches
		// that before recursion ever loops. Here we just stop walking.
		if (seen.has(v)) return;
		seen.add(v);
		const cls = (v as { constructor?: unknown }).constructor;
		if (typeof cls === 'function' && (cls as unknown as Record<symbol, unknown>)[wire]) {
			add('wire', path, 'transportable class — crosses via its [og.wire] codec');
			return;
		}
		if ((v as Record<symbol, unknown>)[Symbol.for('ogygia.derived')] !== undefined) {
			add('store', path, 'resumable derived (og_derived) — its recipe crosses; islands re-derive against the reunified sources');
			return;
		}
		if (is_store(v)) {
			if (is_derived_like(v)) {
				add('warn', path, 'derived/readable store — the VALUE crosses but the derivation does not; islands see a frozen seed. Re-derive client-side or wire the sources');
			} else {
				add('store', path, 'store — auto-wires (current value crosses, islands share one live instance)');
			}
			const extra = Object.keys(v).filter(
				(k) => !STORE_BUILTINS.has(k) && typeof (v as unknown as Record<string, unknown>)[k] === 'function'
			);
			if (extra.length) {
				add(
					'warn',
					path,
					`store methods [${extra.join(', ')}] need a registered factory to survive — mark the factory (mark_store / auto-wire), else islands get a plain writable`
				);
			}
			return;
		}
		if (v instanceof Map) {
			for (const [k, entry] of v) walk(entry, path ? `${path}.get(${String(k)})` : `get(${String(k)})`);
			return;
		}
		if (v instanceof Set) {
			let idx = 0;
			for (const entry of v) walk(entry, `${path}[set:${idx++}]`);
			return;
		}
		if (v instanceof Date || v instanceof RegExp) return; // devalue-native
		if (Array.isArray(v)) {
			v.forEach((entry, idx) => walk(entry, `${path}[${idx}]`));
			return;
		}
		if (!is_plain_object(v)) {
			add(
				'refuse',
				path,
				`instance of class "${(cls as { name?: string })?.name ?? '?'}" without a [og.wire] codec — prototype and methods would be lost; give it \`static wire = import.meta.og.wire({ … })\``
			);
			return;
		}
		for (const k of Object.keys(v)) {
			walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
		}
	})(value, '');

	return findings;
}

/** The findings that make a value undroppable-into-HTML (used to explain a dropped context key). */
export function boundary_problems(value: unknown, key = ''): BoundaryFinding[] {
	return classify_boundary(value, key).filter((f) => f.kind === 'refuse' || f.kind === 'warn');
}

/** Format one finding as the console line for a dropped/degraded context key. */
export function format_boundary_finding(key: string, f: BoundaryFinding): string {
	return `[ogygia] context '${key}'${f.path ? ` @ ${f.path}` : ''}: ${f.detail}`;
}

/**
 * The `import.meta.og.$` rewrite target for NON-function values — the universal boundary
 * assertion. Classifies the value AT THE MARK (creation), so a refusal (DOM node, bare
 * function, unwired class, secret) throws with the marked file:line instead of surfacing
 * deep inside a serializer at request time. Mark-don't-wrap: the value itself is returned
 * untouched — stores/classes/data keep their own passports; identity mints at the seam.
 */
export function __og_boundary<T>(value: T, site: string): T {
	const refusals = classify_boundary(value).filter((f) => f.kind === 'refuse');
	if (refusals.length) {
		const f = refusals[0];
		throw new Error(
			`[ogygia] ${site} — og.$ value${f.path ? ` @ ${f.path}` : ''}: ${f.detail}` +
				(refusals.length > 1 ? ` (+${refusals.length - 1} more)` : '')
		);
	}
	return value;
}
