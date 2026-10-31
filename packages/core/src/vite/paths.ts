/**
 * Package-internal path resolution for the Vite adapter — ogygia's OWN files, addressed head-on
 * (never via `this.resolve`, which isn't portable off a synthetic importer). Split out of index.ts so
 * the plugin file stays lean. Every path resolves relative to THIS module's URL; paths.js and index.js
 * ship in the same `dist/vite/` directory, so `../…` resolves identically from either.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** This package's root (the plugin runs from `dist/vite/`, so `../..` is the package root). A NATIVE
 *  path (backslashes on Windows): for the file system, never to compare against a module id. */
export const PKG_ROOT: string = fileURLToPath(new URL('../..', import.meta.url));

/** Windows separators → posix. */
const WIN_SEP_RE = /\\/g;

/** A native path as Vite writes module ids: symlinks resolved (pnpm), forward slashes (Windows). */
export function real_posix(p: string): string {
	try {
		p = fs.realpathSync(p);
	} catch {
		/* keep as-given — a missing path simply never matches an id */
	}
	return p.replace(WIN_SEP_RE, '/');
}

/** A native directory as the PREFIX of the module ids inside it: `real_posix` + one trailing `/`, so a
 *  `startsWith` never matches a sibling (`ogygia-x/`) and holds on Windows, where the native path has
 *  backslashes and Vite's ids do not. */
export function id_dir(p: string): string {
	const posix = real_posix(p);
	return posix.endsWith('/') ? posix : posix + '/';
}

/** THE own-package test: every module id inside this package starts with this. Every check of "is
 *  this id ogygia's own file" compares against it, never against PKG_ROOT. */
export const PKG_ROOT_ID: string = id_dir(PKG_ROOT);

// Glob metacharacters in a file path handed to `optimizeDeps.entries` (Vite globs entries as
// PATTERNS): a route group `(pes)`, a param dir `[slug]`, `{a,b}`, `*`, `?`, `!`. Escaped, or the
// scanner would read the directory name as glob syntax and never match the file.
const GLOB_META_RE = /[()[\]{}*?!]/g;

/** An island file as an `optimizeDeps.entries` pattern, or null for one of ogygia's OWN islands (the
 *  profiler UI): ogygia is in `optimizeDeps.exclude`, so the scanner can't resolve inside it, and one
 *  unresolved import fails the whole scan (nothing pre-bundles). Its client deps are named up front
 *  instead (the plugin's `dev_island_deps`). */
export function scan_entry_pattern(file: string, own_root: string = PKG_ROOT_ID): string | null {
	const posix = real_posix(file);
	return posix.startsWith(own_root) ? null : posix.replace(GLOB_META_RE, '\\$&');
}

/** The two ogygia self-imports the transform injects into hosts / generated island modules. */
export const OGYGIA_INJECTED_IMPORTS: Set<string> = new Set([
	'ogygia/internal',
	'ogygia/internal/server'
]);

/**
 * DIRECT paths to ogygia's OWN injected runtime entries, resolved WITHOUT `this.resolve`. The
 * transform writes `ogygia/internal` / `ogygia/internal/server` into a host or a generated island
 * module, and a host in a monorepo sub-package that doesn't depend on ogygia must still resolve them.
 * `this.resolve` off a synthetic importer is NOT portable across bundler versions (returns null in
 * vite@8, can THROW in rolldown-vite@7 — which aborts the whole hook), and `config.root` can be
 * undefined on a throwaway Kit plugin instance — so we address ogygia's own files head-on instead.
 *
 * A published install ships only `dist` → `dist/internal.js`. ogygia's OWN source checkout has `src/`,
 * and the rest of the app resolves ogygia through the `svelte` export condition (→ `src`), so there we
 * point at `src/internal.ts` too — same module, no Region/brand identity fork.
 */
const OG_HAS_SRC = fs.existsSync(path.join(PKG_ROOT, 'src/internal.ts'));

/** ogygia's `Region.svelte` — either copy, as the POSIX id Vite hands the transform hook (a workspace
 *  can load the src one and the dist one both): its LateIsland import is the awaiting one where the
 *  app runs Svelte's async mode (late-island.ts). */
export const OGYGIA_REGION_MODULES: ReadonlySet<string> = new Set([
	PKG_ROOT_ID + 'src/Region.svelte',
	PKG_ROOT_ID + 'dist/Region.svelte'
]);
export const OGYGIA_INJECTED_FILES: Record<string, string> = OG_HAS_SRC
	? {
			'ogygia/internal': path.join(PKG_ROOT, 'src/internal.ts'),
			'ogygia/internal/server': path.join(PKG_ROOT, 'src/internal-server.ts')
		}
	: {
			'ogygia/internal': path.join(PKG_ROOT, 'dist/internal.js'),
			'ogygia/internal/server': path.join(PKG_ROOT, 'dist/internal-server.js')
		};

/** Client-side shims aliased for island modules (Kit's client runtime is absent under csr=false). */
export const APP_SHIMS: { '$app/state': string; '$app/stores': string; '$app/navigation': string } =
	{
		'$app/state': fileURLToPath(new URL('../shims/app-state.svelte.js', import.meta.url)),
		'$app/stores': fileURLToPath(new URL('../shims/app-stores.js', import.meta.url)),
		'$app/navigation': fileURLToPath(new URL('../shims/app-navigation.js', import.meta.url))
	};

// A lake's component code must ship in NO client chunk. In the CLIENT build of an island's virtual
// module we swap every lake import for a render-nothing stub (the runtime lifts/restores the lake's
// SSR DOM around hydration). SSR keeps the real component. Same empty `ClientBindingStub` used for
// portable bindings — a lake placeholder and a binding stub are both "render nothing on the client".
/** On-disk stub for `virtual:ogygia/client-binding-stub` (csr=false client hosts). */
export const CLIENT_BINDING_STUB_FILE: string = fileURLToPath(
	new URL('../ClientBindingStub.svelte', import.meta.url)
);

// Reuse Kit's OWN client remote primitives (query/command/form/live). We point
// `__sveltekit/remote` at Kit's real remote-functions and scope-alias the two router-coupled
// modules those pull in (`client.js`, `state.svelte.js`) to tiny stubs, so the router graph
// never loads. The old hand-rolled wire client is gone; these stubs are the only glue.
export const STUB_CLIENT: string = fileURLToPath(
	new URL('../shims/kit-remote/client-stub.js', import.meta.url)
);
export const STUB_STATE: string = fileURLToPath(
	new URL('../shims/kit-remote/state-stub.js', import.meta.url)
);
export const STUB_PATHS: string = fileURLToPath(
	new URL('../shims/kit-remote/paths-internal-stub.js', import.meta.url)
);
export const KIT_REMOTE_CLIENT: RegExp = /(^|\/)client\.js$/;
export const KIT_REMOTE_STATE: RegExp = /state\.svelte\.js$/;

/** Absolute path to real HMAC (SSR-only via `virtual:ogygia/sign`). */
export const HMAC_MODULE: string = fileURLToPath(new URL('../server/hmac.js', import.meta.url));
/** The prebuilt runtime dir the runtime chunk bundles (for `generateRuntimeEntrySource`). */
export const RUNTIME_DIR: string = fileURLToPath(new URL('../runtime', import.meta.url));
/** Absolute path to SSR region-endpoint helper (signed capability URLs). */
export const REGION_ENDPOINT_MODULE: string = fileURLToPath(
	new URL('../server/region-endpoint.js', import.meta.url)
);

// Content-hash the runtime's real inputs (the prebuilt dist files the runtime chunk bundles).
// Kit builds the SERVER bundle BEFORE the client, so a forward handoff of the client chunk's hash
// is impossible — but a SOURCE-content hash is deterministic, so both builds compute the SAME
// filename independently and agree. (Standalone mode still overrides this with the real output
// chunk hash; this is its fallback + the Kit-driven answer.)
function runtime_content_hash(): string {
	const inputs = [
		fileURLToPath(new URL('../compiler/link/runtime-entry.js', import.meta.url)),
		fileURLToPath(new URL('../live-transport.js', import.meta.url)),
		fileURLToPath(new URL('../context-bridge.js', import.meta.url)),
		fileURLToPath(new URL('../keep-fallback-marker.js', import.meta.url)),
		fileURLToPath(new URL('../shims/page-store.svelte.js', import.meta.url)),
		fileURLToPath(new URL('../shims/kit-remote/client-stub.js', import.meta.url)),
		fileURLToPath(new URL('../NestedProvider.svelte', import.meta.url)),
		fileURLToPath(new URL('../LiveHost.svelte', import.meta.url)),
		fileURLToPath(new URL('../KeepHost.svelte', import.meta.url))
	];
	// Every runtime module (core + feature impls + slots) — any change must bust the sticky filename.
	try {
		const rt_dir = fileURLToPath(new URL('../runtime', import.meta.url));
		for (const name of fs.readdirSync(rt_dir)) {
			if (name.endsWith('.js')) inputs.push(path.join(rt_dir, name));
		}
	} catch {
		/* dist may lack runtime until first build */
	}
	const h = crypto.createHash('sha256');
	for (const f of inputs) {
		try {
			h.update(fs.readFileSync(f));
		} catch {
			/* a missing input just doesn't contribute — still deterministic across both builds */
		}
	}
	return h.digest('hex').slice(0, 12);
}

/** The runtime chunk's source-content hash (the immutable-filename base; feature hash rides on top). */
export const RUNTIME_HASH: string = runtime_content_hash();
