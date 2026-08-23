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
import { Compiler, Program, CompileCtx, set_host, set_parser } from 'ogygia/internal/compiler-browser-full';
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

export interface DriverResult {
	/** The transformed host — the SSR leg (islands wrapped, `virtual:ogygia/region/*`). */
	ssr: string | null;
	/** The transformed host — the CLIENT leg (ssr=false: `$app/*`→shim, stubs not wrappers). */
	client: string | null;
	/** The transformed host — the csr=TRUE leg (ogygia steps aside, islands stripped to plain). */
	csrTrue: string | null;
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
		const leg = async (ssr: boolean): Promise<string | null> => {
			const compiler = new Compiler(new Program({ forms: true, router: true }), { prof: {} as never, P: false, outHash: new Map() });
			compiler.configure(repl_ctx(markdown_config));
			try {
				const r = await compiler.transform_module(src, host_id, { ssr, emitFile });
				return r?.code ?? src;
			} catch (e) {
				throw e instanceof Error ? e : new Error(String(e));
			}
		};
		try {
			const ssr = await leg(true);
			const client = await leg(false);
			// csr=true: a route with `export const csr = true` makes the driver step aside (islands → plain).
			this.#files = { ...files, 'src/routes/+layout.ts': 'export const csr = true;' };
			const csrTrue = await leg(true);
			this.#files = files;
			return { ssr, client, csrTrue };
		} catch (e) {
			return { ssr: null, client: null, csrTrue: null, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
		}
	}
}
