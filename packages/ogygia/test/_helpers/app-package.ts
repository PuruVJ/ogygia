// Gives in-memory compiler fixtures (`/app/src/…`, no files on disk) the package.json a Kit app has:
// Kit's `#lib` subpath imports. Installs a compiler host over the real filesystem that also serves
// `<root>/package.json` for each root given, so the compiler's one app resolver reads `#lib` there
// exactly as it would in an app. `dist`: the tests that run against the built compiler pass its host
// module (each build has its own host singleton).
import * as node_fs from 'node:fs';
import node_path from 'node:path';
import node_crypto from 'node:crypto';

type HostModule = { set_host(h?: unknown): void };
type ResolveModule = { clear_app_resolve_cache(): void };

const KIT_IMPORTS = { '#lib': './src/lib', '#lib/*': './src/lib/*' };

export function with_app_package(host: HostModule, resolve: ResolveModule, roots: string[] = ['/app']): () => void {
	const served = new Map(roots.map((r) => [node_path.join(r, 'package.json'), JSON.stringify({ name: 'app', imports: KIT_IMPORTS })]));
	host.set_host({
		fs: {
			...node_fs,
			existsSync: (p: string) => served.has(p) || node_fs.existsSync(p),
			readFileSync: ((p: string, enc?: never) => served.get(p) ?? node_fs.readFileSync(p, enc)) as typeof node_fs.readFileSync
		},
		path: node_path,
		crypto: node_crypto
	});
	resolve.clear_app_resolve_cache();
	return () => {
		host.set_host();
		resolve.clear_app_resolve_cache();
	};
}
