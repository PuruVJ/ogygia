/** the app's folder (the server's working directory, with a trailing slash), read once */
let app_root: string | null | undefined;

function root_of_app(): string | null {
	if (app_root === undefined) {
		try {
			const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
			app_root = cwd ? cwd.split('\\').join('/') : null;
			if (app_root && !app_root.endsWith('/')) app_root += '/';
		} catch {
			app_root = null;
		}
	}
	return app_root;
}

/**
 * AN APP FILE, NAMED FROM THE APP'S FOLDER: `src/lib/x.ts` and `src/routes/a/b/c/+page.svelte`
 * alike, whatever the depth (a cut to the last few segments named one app's files four different
 * ways). Undefined outside the app's folder, and for the build's output (its chunks read by their
 * own short form).
 */
export function app_relative(path: string): string | undefined {
	const root = root_of_app();
	if (!root || !path.startsWith(root)) return undefined;
	const rel = path.slice(root.length);
	return rel.startsWith('.svelte-kit') || rel.startsWith('node_modules/') ? undefined : rel;
}
