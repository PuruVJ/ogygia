/**
 * `preference()` — a persisted, site-wide client CHOICE that flips a CSS state, with zero shipped JS
 * beyond one pre-paint inline script. The csr=false-native primitive behind the JS↔TS code toggle,
 * package-manager tabs, site-wide tab memory, and the theme toggle: one mechanism, many features.
 *
 * A preference is a NAME, its allowed VALUES, and a DEFAULT. On the client the current value lives in
 * `localStorage` and is mirrored onto `<html data-pref-<name>="<value>">` — set BEFORE first paint by
 * {@link Preference.head} (no flash), so CSS can show/hide variants with pure `:root[data-pref-…]`
 * selectors and no hydration. A control calls {@link Preference.set} to change it.
 *
 * ```ts
 * const codeLang = preference({ name: 'code-language', values: ['ts', 'js'], default: 'ts' });
 * // layout <svelte:head>: {@html codeLang.head()}   ← no-flash apply
 * // a toggle's onchange: codeLang.set(checked ? 'ts' : 'js')
 * // CSS: :root[data-pref-code-language="js"] [data-variant="ts"] { display: none }
 * ```
 */
import { script } from './script.js';

/** A preference declaration: its name, allowed values, and default (which must be one of the values). */
export type PreferenceSpec = {
	name: string;
	values: readonly string[];
	default: string;
};

/** A live preference handle — SSR `head()`, client `get()`/`set()`, and the `attr` CSS authors target. */
export interface Preference {
	readonly name: string;
	readonly values: readonly string[];
	readonly default: string;
	/** The attribute set on `<html>`: `data-pref-<name>`. CSS targets `:root[<attr>="<value>"]`. */
	readonly attr: string;
	/** No-flash inline `<script>` string — reads localStorage and applies the attr before paint.
	 *  `{@html}` it once in `<svelte:head>`. Idempotent, so emitting it more than once is harmless. */
	head(): string;
	/** CLIENT: persist + apply a new value (wire a control's handler to this). No-op on the server. */
	set(value: string): void;
	/** CLIENT: the current value (from the applied attr), or the default. Returns the default on the server. */
	get(): string;
}

const KEY = (name: string) => 'og-pref-' + name;
const ATTR = (name: string) => 'data-pref-' + name;

/**
 * ONE delegated click handler that wires every preference switcher on the page: a click on any
 * `[data-pref][data-pref-set]` control (the buttons a variant switcher / package-manager tabs emit)
 * persists + applies that preference. Event delegation, so it survives SPA body-swaps and needs no
 * island. `{@html preference.switch()}` once in the layout, alongside each `preference(spec).head()`.
 * (`switch` is a property, not a binding — reserved words are fine there; mirrors `region.snippet`.)
 */
function preference_switch(): string {
	return script(() => {
		document.addEventListener('click', function (e) {
			var t = e.target;
			var btn = t && (t as Element).closest ? (t as Element).closest('[data-pref][data-pref-set]') : null;
			if (!btn) return;
			var name = btn.getAttribute('data-pref');
			var val = btn.getAttribute('data-pref-set');
			if (!name || !val) return;
			try {
				localStorage.setItem('og-pref-' + name, val);
			} catch (err) {
				/* private mode — the attr still updates for this session */
			}
			document.documentElement.setAttribute('data-pref-' + name, val);
		});
	});
}

/** Declare a site-wide client preference. Throws at creation if `default` isn't one of `values`. */
function preference_impl(spec: PreferenceSpec): Preference {
	if (!spec.values.includes(spec.default)) {
		throw new Error(`[ogygia] preference('${spec.name}'): default '${spec.default}' is not one of values [${spec.values.join(', ')}]`);
	}
	const name = spec.name;
	const values = spec.values;
	const def = spec.default;
	const attr = ATTR(name);
	return {
		name,
		values,
		default: def,
		attr,
		head() {
			// Self-contained (see script()): reads localStorage, validates against `values`, sets the attr.
			return script(
				(n: string, vs: string[], d: string) => {
					try {
						var v = localStorage.getItem('og-pref-' + n);
						if (!v || vs.indexOf(v) < 0) v = d;
						document.documentElement.setAttribute('data-pref-' + n, v);
					} catch (e) {
						document.documentElement.setAttribute('data-pref-' + n, d);
					}
				},
				name,
				values as string[],
				def
			);
		},
		set(value: string) {
			if (typeof document === 'undefined') return;
			const v = values.includes(value) ? value : def;
			try {
				localStorage.setItem(KEY(name), v);
			} catch {
				/* private mode — the attr still updates for this session */
			}
			document.documentElement.setAttribute(attr, v);
		},
		get() {
			if (typeof document === 'undefined') return def;
			const v = document.documentElement.getAttribute(attr);
			return v && values.includes(v) ? v : def;
		}
	};
}

// `preference()` + `preference.switch()` — one namespace, like `region.snippet`. Assigned (not a
// namespace declaration) because `switch` is a reserved word as a binding but a fine property name.
export const preference: typeof preference_impl & { switch: typeof preference_switch } =
	Object.assign(preference_impl, { switch: preference_switch });
