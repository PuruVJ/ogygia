/**
 * `CompileCtx` — the resolved compile context: the config the transform phase reads, plus its
 * derived naming accessors. A plain data holder constructed once the bundler has resolved the build
 * (root / dev / …) and the options are normalized (importKeys / presets / …). It is the config half
 * of the driver's session; the `Compiler` carries it into `transform()` so that phase never reaches
 * back into the Vite adapter — which is what keeps the driver bundler-agnostic (a future REPL feeds
 * a `CompileCtx` + source and gets the same lowering, no Vite in sight).
 */
import path from 'node:path';
import fs from 'node:fs';
import { islandVirtualId } from './ids.js';
import { wrapperVirtualId, type ImportKeys } from './region/transform.js';

const TRAILING_SLASH = /\/$/;

export interface CompileCtxInit {
	root: string;
	base: string;
	libDir: string;
	is_dev: boolean;
	id_salt: string;
	visibleMargin: string | undefined;
	presets: Record<string, unknown>;
	import_keys: ImportKeys;
}

export class CompileCtx {
	readonly root: string;
	readonly base: string;
	readonly libDir: string;
	readonly is_dev: boolean;
	readonly id_salt: string;
	readonly visibleMargin: string | undefined;
	readonly presets: Record<string, unknown>;
	readonly import_keys: ImportKeys;

	constructor(init: CompileCtxInit) {
		this.root = init.root;
		this.base = init.base;
		this.libDir = init.libDir;
		this.is_dev = init.is_dev;
		this.id_salt = init.id_salt;
		this.visibleMargin = init.visibleMargin;
		this.presets = init.presets;
		this.import_keys = init.import_keys;
	}

	/** Read a file as UTF-8, or `null` if it can't be read (the transform tolerates missing deps). */
	read_file(abs: string): string | null {
		try {
			return fs.readFileSync(abs, 'utf-8');
		} catch {
			return null;
		}
	}

	/** Virtual island ENTRY module id for an island id. */
	island_virtual_id(iid: string): string {
		return islandVirtualId(iid);
	}

	/** Virtual wrapper `.svelte` module id for an island id. */
	wrapper_virtual_id(iid: string): string {
		return wrapperVirtualId(iid);
	}

	/** Dev URL for a dynamic `import(entry)` of a virtual island module (honors a non-root base). */
	dev_url_for(virtualPath: string): string {
		const prefix = this.base && this.base !== '/' ? this.base.replace(TRAILING_SLASH, '') : '';
		return prefix + '/@id/' + virtualPath;
	}
}
