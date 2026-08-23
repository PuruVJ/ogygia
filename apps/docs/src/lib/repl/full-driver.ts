/**
 * Drives the FULL ogygia `Compiler` in the browser worker — one pass that runs EVERY macro (including
 * `$`/`store`, which the lean path skips) + the transportable-class registration, and can `emit()` the
 * manifests. So the Observatory's compiler OUTPUT becomes complete instead of the lean `transformHost`'s
 * partial view (where `import.meta.og.$` shows untransformed and no manifests appear).
 *
 * It reuses the REAL driver — the enabling changes were three seams in the library: parse via the oxc
 * seam (not `import from 'vite'`), a lazy `bake` (its node-only dynamic imports leave the static graph),
 * and a file-map-backed host fs so `prescan()` sees the workspace. This module installs its OWN
 * host/parser seams so it's self-consistent even if the full + lean entries don't share the singleton.
 */
import {
	Compiler,
	Program,
	CompileCtx,
	set_host,
	set_parser,
	RESOLVED,
	V_TRANSPORTABLES,
	V_TRANSPORT,
	V_FN_MANIFEST,
	V_SERVER_MANIFEST,
	V_RUNTIME_ENTRY
} from 'ogygia/internal/compiler-browser-full';
import { make_repl_host } from './browser-host.ts';

/** The two-dial import-attribute grammar (defaults). */
const IMPORT_KEYS = { wake: 'wake', render: 'render', preset: 'preset', region: 'region' };

/** A CompileCtx tuned for the REPL: a `/repl` root, dev mode, signing/endpoint fields stubbed (the
 *  Observatory shows the compiler OUTPUT, it doesn't serve signed endpoints). */
function repl_ctx(markdown_config: unknown): CompileCtx {
	return new CompileCtx({
		root: '/repl',
		base: '/',
		libDir: '/repl/src/lib',
		is_dev: true,
		id_salt: 'repl',
		visibleMargin: undefined,
		presets: {},
		import_keys: IMPORT_KEYS as never,
		resolve_alias: [],
		markdown_config,
		pkg_root: '/node_modules/ogygia', // never matches a /repl/* file → auto-brand won't skip user source
		build_secret: 'repl',
		rate_limit: { max: 0, windowMs: 0 },
		session_cookie: '',
		region_ttl: 3600,
		router_enabled: true,
		router_view_transitions: true,
		runtime_dir: '/node_modules/ogygia/dist/runtime',
		runtime_hash: 'repl',
		hmac_module: 'ogygia/internal/server',
		region_endpoint_module: 'ogygia/internal/server',
		client_binding_stub_file: '/node_modules/ogygia/dist/runtime/client-binding-stub.js',
		app_shims: {},
		is_build: false,
		content_presets: null
	});
}

/** One row of the driver's REAL virtual-module registry — an island / wrapper / held-region artifact the
 *  linker minted, with its true (content-hashed md5) id. Replaces the Observatory's basename-matched
 *  placeholder ids + mark scan in the Regions view. */
/** Basename of a (possibly query-suffixed) path — `…/Counter.svelte?x` → `Counter.svelte`. */
function base_name(p: string | null | undefined): string {
	if (!p) return '';
	return p.split('?')[0].split('/').pop() || p;
}

/** Read the REAL generated manifest modules off an SSR-leg Compiler — the exact source `emit()` produces
 *  for each `virtual:ogygia/*` manifest, the same modules a real build ships. Each `emit` is wrapped so a
 *  node-only branch (should any remain) degrades to an empty string instead of failing the whole analyze. */
function extract_manifests(compiler: Compiler): DriverManifests {
	const c = compiler as unknown as { emit: (id: string, o: unknown) => string | null };
	const opts = { ssr: true, hashedRuntimeUrl: null, universalHooks: null };
	const one = (v: string): string => {
		try {
			return c.emit(RESOLVED(v), opts) ?? '';
		} catch {
			return '';
		}
	};
	return {
		transportables: one(V_TRANSPORTABLES),
		transport: one(V_TRANSPORT),
		fnManifest: one(V_FN_MANIFEST),
		serverManifest: one(V_SERVER_MANIFEST),
		runtimeEntry: one(V_RUNTIME_ENTRY)
	};
}

/** Boil a leg's Compiler down to the collapse-comparison counts (used for the csr=true leg). */
function extract_csr_summary(compiler: Compiler): DriverCsrSummary {
	const regions = extract_regions(compiler);
	const codecs = extract_codecs(compiler);
	return {
		regions: regions.length,
		fns: codecs.fns.length,
		transportables: codecs.transportables.length,
		wiringBytes: regions.reduce((sum, r) => sum + r.clientBytes, 0)
	};
}

/** Read the driver's real WIRE graph off an SSR-leg Compiler — the codecs that actually cross a boundary:
 *  transportable classes (`static wire = import.meta.og.wire`), `import.meta.og.$` fn refs, and the runtime
 *  feature marks the sticky entry will carry. The Wire view shows props-by-value AND this codec graph. */
function extract_codecs(compiler: Compiler): DriverCodecs {
	const c = compiler as unknown as {
		program: { transportable_modules: Set<string>; runtime_marks: Record<string, unknown> };
		dollar_hoists: Map<string, string>;
	};
	const rel = (p: string) => p.replace(/^\/repl\//, '').replace(/^\/+/, '');
	// The feature marks that are actually ON (a boolean flag set, or a non-empty id list).
	const marks: string[] = [];
	for (const [k, v] of Object.entries(c.program.runtime_marks)) {
		if (v === true) marks.push(k);
		else if (Array.isArray(v) && v.length) marks.push(`${k}(${v.length})`);
	}
	return {
		transportables: [...c.program.transportable_modules].map(rel).sort(),
		fns: [...c.dollar_hoists.keys()].sort(),
		marks: marks.sort()
	};
}

/** Read the driver's real registry off an SSR-leg Compiler — every island/wrapper/held-region the linker
 *  minted, with its true content-hashed id and scheduling kind. This is what the Regions view shows
 *  instead of the basename-matched placeholder ids + `with { … }` mark scan. */
function extract_regions(compiler: Compiler): DriverRegion[] {
	const program = compiler.program as unknown as {
		registry: Map<string, Record<string, unknown>>;
		region_kinds: Map<string, 'hydrate' | 'defer' | 'lake'>;
	};
	const enc = new TextEncoder();
	const rows: DriverRegion[] = [];
	for (const [vpath, e] of program.registry) {
		const ssrSource = e.ssrSource as string | undefined;
		const clientSource = e.clientSource as string | undefined;
		const source = e.source as string | undefined;
		// A held region keeps its leg split (ssrSource/clientSource); an island/wrapper carries ONE
		// `source` used for both legs (client gets `$app` shims + lake placeholders at emit). So the
		// generated client-leg module is `clientSource` for a region, else `source`.
		const client_leg = clientSource ?? source;
		rows.push({
			id: (e.id as string) ?? '',
			role: (e.role as DriverRegion['role']) ?? 'entry',
			component: base_name(e.componentPath as string),
			componentPath: (e.componentPath as string) ?? null,
			server: !!e.server,
			portable: !!e.portable,
			lakes: (e.lakes as string[]) ?? [],
			kind: program.region_kinds.get(e.id as string) ?? null,
			vpath,
			ssrSource,
			clientSource,
			source,
			clientBytes: client_leg ? enc.encode(client_leg).length : 0
		});
	}
	return rows;
}

/** One row of the driver's REAL virtual-module registry — an island / wrapper / held-region artifact the
 *  linker minted, with its true (content-hashed md5) id. Replaces the Observatory's basename-matched
 *  placeholder ids + mark scan in the Regions view. */
export interface DriverRegion {
	/** The build's real content-hashed id (md5), not a placeholder FNV. */
	id: string;
	/** `entry` (a wake wrapper) · `wrapper` (dedup shell) · `region` (held-value binding). */
	role: 'entry' | 'wrapper' | 'region';
	/** Component basename, e.g. `Counter.svelte`. */
	component: string;
	/** Root-relative component path, or null (a synthesized region). */
	componentPath: string | null;
	/** A server island (`render: 'deferred'`). */
	server: boolean;
	/** A portable (a snippet/binding that crosses a boundary alive). */
	portable: boolean;
	/** Lake locals excluded from this island's client chunk. */
	lakes: string[];
	/** The scheduling kind the linker recorded. */
	kind: 'hydrate' | 'defer' | 'lake' | null;
	/** The generated virtual module path (`virtual:ogygia/island|region/<id>.js`). */
	vpath: string;
	/** The generated SSR + client leg sources (the "generated modules" panel). */
	ssrSource?: string;
	clientSource?: string;
	source?: string;
	/** Real byte size (UTF-8) of the generated CLIENT leg — the actual island-wiring ogygia ships for
	 *  this module. 0 when the module has no standalone client leg (rendered inline / binding-only). */
	clientBytes: number;
}

/** The REAL generated manifest modules — the exact source a build emits for each. Empty string when a
 *  manifest is a no-op (no transportables, no fn refs, …). */
export interface DriverManifests {
	/** `virtual:ogygia/transportables` — eager `__register_transportable(tag, Cls)` calls per class. */
	transportables: string;
	/** `virtual:ogygia/transport` — the devalue transport codec map (+ app `transport` hooks). */
	transport: string;
	/** `virtual:ogygia/fn-manifest` — the `import.meta.og.$` factory registrations (pre-hydration). */
	fnManifest: string;
	/** `virtual:ogygia/server-manifest` — region id → kind/endpoint, populated in dev + build. */
	serverManifest: string;
	/** `virtual:ogygia/runtime-entry` — the feature-selected runtime entry the app's islands boot from. */
	runtimeEntry: string;
}

/** A compact summary of the csr=TRUE leg — for the collapse comparison (how much of the island machinery
 *  survives when ogygia steps aside and plain Kit hydrates the whole page). Islands/wiring go to ~0; a
 *  page-level `import.meta.og.$` still transforms (it isn't island-specific). */
export interface DriverCsrSummary {
	/** Island/region modules the linker minted on csr=true (≈0 — ogygia stands down). */
	regions: number;
	/** `import.meta.og.$` fn refs still present (these transform regardless of csr). */
	fns: number;
	/** Transportable classes still registered. */
	transportables: number;
	/** Total island-wiring client bytes emitted (≈0 on csr=true — no wrappers/entries). */
	wiringBytes: number;
}

/** The driver's real wire/codec graph — what actually crosses a boundary, by kind. */
export interface DriverCodecs {
	/** Root-relative modules that define a transportable class (`static wire = import.meta.og.wire`). */
	transportables: string[];
	/** `import.meta.og.$` fn-ref tags (each a fn that crosses as a ref). */
	fns: string[];
	/** Runtime feature marks that are ON (hydrate/defer/router/live/wire/…; list marks show a count). */
	marks: string[];
}

export interface DriverResult {
	/** The transformed host — the SSR leg (islands wrapped, `virtual:ogygia/region/*`). */
	ssr: string | null;
	/** The transformed host — the CLIENT leg (ssr=false: `$app/*`→shim, stubs not wrappers). */
	client: string | null;
	/** The transformed host — the csr=TRUE leg (ogygia steps aside, islands stripped to plain). */
	csrTrue: string | null;
	/** The REAL registry the SSR leg minted — true island/region ids, roles, kinds, generated sources. */
	regions?: DriverRegion[];
	/** The REAL wire graph — transportable classes, fn refs, and active runtime marks. */
	codecs?: DriverCodecs;
	/** The REAL generated manifest module sources (transportables / transport / fn / server / runtime). */
	manifests?: DriverManifests;
	/** The csr=TRUE leg's collapse summary — for the "on csr=true this all vanishes" comparison. */
	csr?: DriverCsrSummary;
	error?: string;
	/** Full stack of a failing leg — Observatory-side diagnostic only (which module touched `window` etc.). */
	stack?: string;
}

export class ReplDriver {
	#files: Record<string, string> = {};
	#installed = false;

	/** Install the full driver's OWN host + parser seams (reads the current files live). Idempotent. */
	install(parse_sync: (id: string, code: string) => unknown): void {
		if (this.#installed) return;
		set_host(make_repl_host(() => this.#files));
		set_parser((id: string, code: string) => parse_sync(id, code) as never);
		this.#installed = true;
	}

	/** Run the full driver over the workspace, returning the transformed host for each csr leg. A fresh
	 *  Program/Compiler per call keeps cross-file linker state from leaking between edits. */
	async analyze(files: Record<string, string>, markdown_config: unknown, host_rel: string): Promise<DriverResult> {
		this.#files = files;
		const host_id = '/repl/' + host_rel.replace(/^\/+/, '');
		const src = files[host_rel] ?? '';
		const emitFile = () => {};
		// A leg returns its transformed host AND its Compiler — the SSR leg's Compiler carries the real
		// linker Program (registry / region kinds / marks) the Regions view reads.
		const leg = async (ssr: boolean): Promise<{ code: string | null; compiler: Compiler }> => {
			const compiler = new Compiler(new Program({ forms: true, router: true }), { prof: {} as never, P: false, outHash: new Map() });
			compiler.configure(repl_ctx(markdown_config));
			try {
				const r = await compiler.transform_module(src, host_id, { ssr, emitFile });
				return { code: r?.code ?? src, compiler };
			} catch (e) {
				throw e instanceof Error ? e : new Error(String(e));
			}
		};
		try {
			const ssrLeg = await leg(true);
			const client = (await leg(false)).code;
			// csr=true: a route with `export const csr = true` makes the driver step aside (islands → plain).
			this.#files = { ...files, 'src/routes/+layout.ts': 'export const csr = true;' };
			const csrLeg = await leg(true);
			this.#files = files;
			return {
				ssr: ssrLeg.code,
				client,
				csrTrue: csrLeg.code,
				regions: extract_regions(ssrLeg.compiler),
				codecs: extract_codecs(ssrLeg.compiler),
				manifests: extract_manifests(ssrLeg.compiler),
				csr: extract_csr_summary(csrLeg.compiler)
			};
		} catch (e) {
			return { ssr: null, client: null, csrTrue: null, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
		}
	}
}
