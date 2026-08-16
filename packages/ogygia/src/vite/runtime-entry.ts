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
	| 'persist'
	| 'router'
;

export type FeatureDef = {
	/** Path relative to `runtime/` (no leading ./). */
	module: string;
	deps: FeatureId[];
	detect: (m: RuntimeMarks) => boolean;
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
	persist: {
		module: 'persist.js',
		deps: ['live'],
		detect: (m) => m.persist === true || (m.persistKeys || []).length > 0
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
		detect: (m) => m.live === true || m.morph === true
	},
	live: {
		module: 'live.js',
		deps: [],
		detect: (m) => m.live === true
	},
	wire: {
		module: '../live-transport.js',
		deps: [],
		// Opt-IN: only when the app actually ships a transportable class or a portable snippet (the
		// build sets `wire: true` on detecting either). A plain-props app never bundles the ~8kB codec.
		detect: (m) => m.wire === true
	},
	'remote-seeds': {
		module: 'remote-seeds.js',
		deps: [],
		detect: (m) => m.remoteSeeds !== false
	},
	frames: {
		module: 'frames.js',
		deps: [],
		// The client frame store, needed by any region that streams HTML: a deferred region (server
		// island / held region), a live/morphing region, or a lake. A plain load-hydrated app has
		// none of these and tree-shakes the store away. (The router's single-flight nav imports the store separately.)
		detect: (m) => (m.defer || []).length > 0 || m.live === true || m.morph === true || m.lakes === true
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
	'persist',
	'router'
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

/**
 * Emit an ESM entry that boots only the selected features.
 * @param runtimeDir Absolute directory containing `core.js` + the feature modules.
 */
/**
 * Emit an ESM entry that boots only the selected features.
 * @param runtimeDir Absolute directory containing `core.js` + the feature modules.
 */
export function generateRuntimeEntrySource(
	marks: RuntimeMarks,
	runtimeDir: string
): { code: string; features: FeatureId[] } {
	const features = resolveFeatures(marks);
	const toAlias = (id: string) => id.replace(HYPHEN, '_');
	// Absolute filesystem paths — Vite/Rolldown resolve these; `file://` URLs do not.
	const corePath = `${runtimeDir}/core.js`.replace(BACKSLASH, '/');
	const featPath = (mod: string) => `${runtimeDir}/${mod}`.replace(BACKSLASH, '/');

	const lines: string[] = [];
	lines.push(`/** generated ogygia runtime — features: ${features.join(', ') || '(core only)'} */`);
	lines.push(`import { boot } from ${JSON.stringify(corePath)};`);
	for (const id of features) {
		lines.push(`import * as ${toAlias(id)} from ${JSON.stringify(featPath(FEATURES[id].module))};`);
	}
	lines.push('');
	lines.push('boot([');
	for (const id of features) lines.push(`  ${toAlias(id)}.install,`);
	lines.push(']);');
	lines.push(`export const __features = ${JSON.stringify(features)};`);
	return { code: lines.join('\n') + '\n', features };
}
