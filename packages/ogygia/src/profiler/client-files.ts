/**
 * Where the BROWSER's scripts live on disk: a browser CPU trace names its frames by URL
 * (`https://site/_app/immutable/chunks/X.js`), and the source maps for those chunks sit next to
 * the built client files, not on the server's chunk paths. These helpers find the client output
 * dir and turn an app asset URL into the local file, so the same resolver that names server
 * frames names browser frames too. Pure; the host supplies `exists`.
 */

/** Kit's client output dirs to try, most likely first: the adapter's layout (`build/index.js` →
 *  `build/client`), Kit's own output during `vite preview`, and the two under the cwd. */
export function client_dir_candidates(entry_dir: string | undefined, cwd: string, join: (...p: string[]) => string): string[] {
	const out: string[] = [];
	const add = (d: string) => {
		if (!out.includes(d)) out.push(d);
	};
	if (entry_dir) {
		add(join(entry_dir, 'client'));
		add(join(entry_dir, '..', 'client'));
	}
	add(join(cwd, '.svelte-kit', 'output', 'client'));
	add(join(cwd, 'build', 'client'));
	return out;
}

/** The path of an app asset inside the client dir (`/base/_app/immutable/chunks/X.js` →
 *  `_app/immutable/chunks/X.js`), or undefined when the URL is not one of the app's own. */
export function app_asset_rel(pathname: string): string | undefined {
	const i = pathname.indexOf('/_app/');
	if (i === -1) return undefined;
	const rel = pathname.slice(i + 1);
	// never let a crafted resource name walk out of the client dir
	if (rel.split('/').some((s) => s === '..' || s === '')) return undefined;
	return rel;
}

/** A finder from URL to local file: same-origin app assets only, the first client dir that has
 *  the file wins, cached per URL. `origin` is the page's origin (the beacon's request origin). */
export function client_file_finder(
	origin: string | undefined,
	dirs: readonly string[],
	exists: (p: string) => boolean,
	join: (...p: string[]) => string
): (url: string) => string | undefined {
	const cache = new Map<string, string | undefined>();
	let dir: string | undefined;
	return (url) => {
		const hit = cache.get(url);
		if (hit !== undefined || cache.has(url)) return hit;
		let file: string | undefined;
		try {
			const u = new URL(url, origin ?? 'http://x');
			if (!origin || u.origin === origin) {
				const rel = app_asset_rel(u.pathname);
				if (rel) {
					if (dir && exists(join(dir, rel))) file = join(dir, rel);
					else {
						for (const d of dirs) {
							if (exists(join(d, rel))) {
								dir = d;
								file = join(d, rel);
								break;
							}
						}
					}
				}
			}
		} catch {
			/* not a URL */
		}
		cache.set(url, file);
		return file;
	};
}
