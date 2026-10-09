const HYPHEN = /-/g;
const BACKSLASH = /\\/g;

/**
 * Runtime feature catalog — maps build-time marks → installable plugins.
 * Module paths are absolute file URLs resolved by the Vite plugin against dist/src.
 */

export type RuntimeMarks = {
	/** When false/undefined, emit kitchen-sink (safe default). */
	complete?: boolean;
	hydrate?: string[];
	defer?: string[];
	persist?: boolean;
	persistKeys?: string[];
	router?: boolean;
	live?: boolean;
	morph?: boolean;
	lakes?: boolean;
	forms?: boolean;
	wire?: boolean;
	remoteSeeds?: boolean;
	/** App imports an ogygia context provider (`Provide` / `setContext` / `createContext`). Set by the
	 *  driver's import scan; gates the cross-island context bridge (~4.7 kB) out of apps that never
	 *  provide context. Read-only providers (`getContext`) don't set it — there's nothing to bridge. */
	context?: boolean;
};

export type FeatureId =
	| 'remote-seeds'
	| 'wire'
	| 'frames'
	| 'lakes'
	| 'morph'
	| 'live'
	| 'interaction'
	| 'forms'
	| 'router'
	| 'context';

/**
 * WHICH CHUNK a feature lives in. The runtime ships as two static, feature-sized phases:
 *
 * - `boot` — the runtime entry (`og-runtime.*.js`), loaded by the `<script>` in `<head>`. Defines
 *   `<ogygia-region>`, schedules wakes, fetches holes, morphs, routes. It must never reach Svelte:
 *   in a real app Svelte's client runtime is ONE shared chunk (~200 KB), and anything in the boot's
 *   static graph downloads first, ahead of the page's own LCP image, before any island needs it.
 * - `hydrate` — the hydrate core (`runtime/hydrate-core.js`), loaded by the runtime's single existing
 *   `import()` when the first island wakes, together with Svelte (which `hydrate()` needs anyway). A
 *   feature whose slot only the hydrate core reads belongs here, installed as the chunk evaluates.
 *
 * Both phases are generated from the same marks, so each is exactly as big as the app needs; no
 * feature adds a dynamic import of its own. `test/runtime-boot-svelte-free.test.ts` pins the boot.
 */
export type FeaturePhase = 'boot' | 'hydrate';

export type FeatureDef = {
	/** Path relative to `runtime/` (no leading ./). */
	module: string;
	deps: FeatureId[];
	detect: (m: RuntimeMarks) => boolean;
	/** Default `boot`. See {@link FeaturePhase}. */
	phase?: FeaturePhase;
};

export const FEATURES: Record<FeatureId, FeatureDef> = {
	interaction: {
		module: 'interaction.js',
		deps: [],
		detect: (m) => (m.hydrate || []).includes('interaction')
	},
	forms: {
		module: 'form-continuity.js',
		deps: [],
		detect: (m) => m.forms === true || (m.forms !== false && m.router === true)
	},
	router: {
		module: 'router.js',
		deps: [],
		detect: (m) => m.router === true
	},
	lakes: {
		module: 'lakes.js',
		deps: [],
		detect: (m) => m.lakes === true || (m.hydrate || []).includes('none')
	},
	morph: {
		module: 'morph.js',
		deps: [],
		// Also any DEFERRED hole: its answer swaps over a fallback that may have become interactive
		// before it landed — a foreign web component upgraded it, or the fallback itself hydrated — and
		// #apply must MORPH that live node, not replace it (a plain swap re-creates a menu open right
		// now; core.ts #apply). The frames feature already tracks `defer` for the same streamed HTML.
		detect: (m) => m.live === true || m.morph === true || m.router === true || (m.defer || []).length > 0
	},
	live: {
		module: 'live.js',
		deps: [],
		// Hydrate phase: `LiveHost` is a Svelte component, read only by the hydrate core.
		phase: 'hydrate',
		detect: (m) => m.live === true || m.persist === true || (m.persistKeys || []).length > 0
	},
	wire: {
		module: '../live-transport.js',
		deps: [],
		// Hydrate phase: the codec (and its store / snippet kinds, which reach Svelte) is read only
		// while an island's props are revived, inside the hydrate core.
		phase: 'hydrate',
		// Opt-IN: only when the app actually ships a transportable class or a portable snippet (the
		// build sets `wire: true` on detecting either). A plain-props app never bundles the ~8kB codec.
		detect: (m) => m.wire === true
	},
	'remote-seeds': {
		module: 'remote-seeds.js',
		deps: [],
		// Hydrate phase: the seed is read only by the hydrate core, and its decoder imports the APP's
		// transport codecs (its own `src/hooks.ts`), which reach Svelte.
		phase: 'hydrate',
		detect: (m) => m.remoteSeeds !== false
	},
	frames: {
		module: 'frames.js',
		deps: [],
		// The client frame store, needed by any region that streams HTML: a deferred region (server
		// island / held region), a live/morphing region, or a lake. A plain load-hydrated app has
		// none of these and tree-shakes the store away. (The router's single-flight nav imports the store separately.)
		detect: (m) =>
			(m.defer || []).length > 0 || m.live === true || m.morph === true || m.lakes === true
	},
	context: {
		module: 'context.js',
		deps: [],
		// Hydrate phase: the bridge seeds an island's context at hydrate, and reaches Svelte.
		phase: 'hydrate',
		// The cross-island context bridge. Opt-IN: only when the app imports an ogygia context provider
		// (`Provide` / `setContext` / `createContext` from 'ogygia'). A read-only or context-free app
		// tree-shakes the ~4.7 kB DOM-walk + devalue reviver away.
		detect: (m) => m.context === true
	}
};

export const FEATURE_ORDER: FeatureId[] = [
	'remote-seeds',
	'wire',
	'frames',
	'lakes',
	'morph',
	'live',
	'interaction',
	'forms',
	'router',
	'context'
];

/** Resolve the closed feature set for a marks manifest. */
export function resolveFeatures(marks: RuntimeMarks): FeatureId[] {
	// Incomplete marks → kitchen sink (behavioral parity with today's monolith).
	if (!marks.complete) return [...FEATURE_ORDER];

	const selected = new Set<FeatureId>();
	for (const id of FEATURE_ORDER) {
		if (FEATURES[id].detect(marks)) selected.add(id);
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const id of [...selected]) {
			for (const d of FEATURES[id].deps) {
				if (!selected.has(d)) {
					selected.add(d);
					changed = true;
				}
			}
		}
	}

	return FEATURE_ORDER.filter((id) => selected.has(id));
}

const to_alias = (id: string) => id.replace(HYPHEN, '_');
// Absolute filesystem paths — Vite/Rolldown resolve these; `file://` URLs do not.
const runtime_path = (runtimeDir: string, mod: string) => `${runtimeDir}/${mod}`.replace(BACKSLASH, '/');

/** The selected features of one {@link FeaturePhase}, in FEATURE_ORDER. */
export function phaseFeatures(marks: RuntimeMarks, phase: FeaturePhase): FeatureId[] {
	return resolveFeatures(marks).filter((id) => (FEATURES[id].phase ?? 'boot') === phase);
}

/**
 * Emit the BOOT entry: core + the selected boot-phase features (see {@link FeaturePhase}).
 * @param runtimeDir Absolute directory containing `core.js` + the feature modules.
 */
export function generateRuntimeEntrySource(
	marks: RuntimeMarks,
	runtimeDir: string
): { code: string; features: FeatureId[] } {
	const features = phaseFeatures(marks, 'boot');
	const lines: string[] = [];
	lines.push(`/** generated ogygia runtime — features: ${features.join(', ') || '(core only)'} */`);
	lines.push(`import { boot } from ${JSON.stringify(runtime_path(runtimeDir, 'core.js'))};`);
	for (const id of features) {
		lines.push(`import * as ${to_alias(id)} from ${JSON.stringify(runtime_path(runtimeDir, FEATURES[id].module))};`);
	}
	lines.push('');
	lines.push('boot([');
	for (const id of features) lines.push(`  ${to_alias(id)}.install,`);
	lines.push(']);');
	// Side effects only: the entry boots and exports nothing (no consumer ever read an export).
	return { code: lines.join('\n') + '\n', features };
}

/**
 * Emit the HYDRATE-phase feature module (`virtual:ogygia/hydrate-features`), which the hydrate core
 * imports statically and installs as its chunk evaluates — so these features ride the hydrate core's
 * one existing `import()`, sized by the same marks as the boot. `all` (dev / no marks): every one.
 * @param runtimeDir Absolute directory containing the feature modules.
 */
export function generateHydrateFeaturesSource(
	marks: RuntimeMarks,
	runtimeDir: string,
	all = false
): { code: string; features: FeatureId[] } {
	const features = all
		? FEATURE_ORDER.filter((id) => FEATURES[id].phase === 'hydrate')
		: phaseFeatures(marks, 'hydrate');
	const lines: string[] = [];
	lines.push(`/** generated ogygia hydrate-phase features: ${features.join(', ') || '(none)'} */`);
	for (const id of features) {
		lines.push(`import * as ${to_alias(id)} from ${JSON.stringify(runtime_path(runtimeDir, FEATURES[id].module))};`);
	}
	lines.push('export function install() {');
	for (const id of features) lines.push(`  ${to_alias(id)}.install();`);
	lines.push('}');
	return { code: lines.join('\n') + '\n', features };
}
