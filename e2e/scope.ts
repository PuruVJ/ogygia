/**
 * WHICH SPECS A CHANGE CAN BREAK — the e2e suite's scoping (e2e/affected.ts runs it). Turbo scopes the
 * unit tests by the package graph; the e2e suite runs against ONE app (the playground) that lists
 * every plugin, so it scopes by ownership instead:
 *
 * - a change to a plugin package (outside its unit tests) runs that plugin's specs, the specs of every
 *   package that depends on it, and the SMOKE set — every plugin's server half runs on every
 *   playground request, so a broken plugin shows up in plain page loads too;
 * - a change to a fixture app or a spec runs the specs that use it;
 * - a change to docs, notes or unit tests runs nothing;
 * - anything else (core, the tooling, the playground, the e2e harness, the lockfile, root config)
 *   runs everything.
 *
 * A spec not owned by any plugin belongs to core.
 */

/** Each plugin package's own specs, by its directory under packages/. */
export const OWNERS: Record<string, readonly string[]> = {
	// (the A/B flag read a stored page refuses lives in the freeze suite)
	flags: ['freeze.spec.ts'],
	freeze: ['freeze.spec.ts', 'freeze-dev.spec.ts'],
	federation: ['federation.spec.ts', 'mfe-foreign-page.spec.ts'],
	content: ['content-css.spec.ts'],
	devtools: [
		'devtools.spec.ts',
		'profiler-serverless.spec.ts',
		'profiler-window-instances.spec.ts',
		'dev-installed.spec.ts',
		'ogygia-testing.spec.ts'
	],
	testing: ['ogygia-testing.spec.ts'],
	router: ['router-seed.spec.ts', 'stream-page.spec.ts', 'island-pkg.spec.ts'],
	// (the command line is unit-tested only)
	cli: []
};

/** Broad page loads every plugin's server half takes part in. */
export const SMOKE: readonly string[] = ['browser.spec.ts', 'server-islands.spec.ts', 'mixed.spec.ts'];

/** Fixture apps (and other paths outside packages/) and the specs that use them. */
const FIXTURES: readonly [prefix: string, specs: readonly string[]][] = [
	['examples/mfe/', ['federation.spec.ts', 'mfe-foreign-page.spec.ts']],
	['internal/repro-freeze/', ['freeze.spec.ts', 'freeze-dev.spec.ts']],
	['internal/repro-island-pkg/', ['island-pkg.spec.ts']],
	['internal/repro-kit3/', ['kit3.spec.ts']],
	['e2e/adapters/', ['adapters.spec.ts']]
];

// ── regexes
const PKG_TEST_RE = /^packages\/[^/]+\/test\//;
const PKG_RE = /^packages\/([^/]+)\//;
const SPEC_RE = /^e2e\/([^/]+\.spec\.ts)$/;

/** Paths no e2e spec can see. */
function inert(file: string): boolean {
	return (
		file.endsWith('.md') ||
		file.startsWith('internal/notes/') ||
		file.startsWith('.changeset/') ||
		file.startsWith('.claude/') ||
		file.startsWith('apps/docs/') ||
		PKG_TEST_RE.test(file)
	);
}

export interface Workspace {
	/** packages/<dir> → its package name */
	names: Record<string, string>;
	/** package name → the workspace package names it depends on (dependencies + peers) */
	deps: Record<string, readonly string[]>;
}

/** What to run for these changed files (repo-relative): every spec (`all`), or `specs` (possibly
 *  none); `why` says which change asked for what. */
export interface Affected {
	all: boolean;
	specs: string[];
	why: string[];
}

export function affected_specs(changed: readonly string[], ws: Workspace): Affected {
	const plugins = new Set<string>();
	const specs = new Set<string>();
	const why: string[] = [];
	for (const file of changed) {
		if (inert(file)) continue;
		const pkg = PKG_RE.exec(file);
		if (pkg) {
			if (!(pkg[1] in OWNERS))
				return { all: true, specs: [], why: [`${file} (${ws.names[pkg[1]] ?? pkg[1]} is not a plugin)`] };
			plugins.add(pkg[1]);
			continue;
		}
		const spec = SPEC_RE.exec(file);
		if (spec) {
			specs.add(spec[1]);
			why.push(`${file} → itself`);
			continue;
		}
		const fixture = FIXTURES.find(([prefix]) => file.startsWith(prefix));
		if (fixture) {
			for (const s of fixture[1]) specs.add(s);
			why.push(`${file} → ${fixture[1].join(', ')}`);
			continue;
		}
		return { all: true, specs: [], why: [file] };
	}
	// a plugin's dependents are affected too (a router change reaches federation and devtools)
	const by_name = Object.fromEntries(Object.entries(ws.names).map(([dir, name]) => [name, dir]));
	const queue = [...plugins];
	while (queue.length) {
		const dir = queue.pop()!;
		const name = ws.names[dir];
		for (const [other, deps] of Object.entries(ws.deps)) {
			const other_dir = by_name[other];
			if (other_dir && other_dir in OWNERS && deps.includes(name) && !plugins.has(other_dir)) {
				plugins.add(other_dir);
				queue.push(other_dir);
			}
		}
	}
	for (const dir of plugins) {
		for (const s of OWNERS[dir]) specs.add(s);
		why.push(`${ws.names[dir] ?? dir} → ${OWNERS[dir].join(', ') || '(no specs of its own)'}`);
	}
	if (plugins.size && [...plugins].some((d) => OWNERS[d].length)) {
		for (const s of SMOKE) specs.add(s);
		why.push(`plugin changed → smoke: ${SMOKE.join(', ')}`);
	}
	return { all: false, specs: [...specs].sort(), why };
}
