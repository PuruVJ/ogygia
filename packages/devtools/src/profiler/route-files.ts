/**
 * WHICH ROUTE A FILE BELONGS TO — a page or layout file under `src/routes` (or its built chunk under
 * `entries/pages`), and whether it is ANOTHER route's than the one profiled: a visitor of another
 * page whose work landed in the same window. Pure and import-free: the CPU analysis, the report and
 * the report's browser side all ask it.
 */

/** a route's page or layout file, by its folder under `src/routes` (`form: 'src'`) or its built
 *  chunk under `entries/pages` (`'built'`: `[id]` written `_id_`); undefined for any other file */
export function route_file_of(path: string): { dir: string; page: boolean; form: 'src' | 'built' } | undefined {
	const read = (marker: string, form: 'src' | 'built', page: string, layout: string[]) => {
		const at = path.lastIndexOf(marker);
		if (at === -1) return undefined;
		const rel = path.slice(at + marker.length);
		const slash = rel.lastIndexOf('/');
		const base = rel.slice(slash + 1);
		const dir = slash === -1 ? '' : rel.slice(0, slash);
		if (base.startsWith(page)) return { dir, page: true, form };
		if (layout.some((l) => base.startsWith(l))) return { dir, page: false, form };
		return undefined;
	};
	return read('/src/routes/', 'src', '+page', ['+layout', '+error']) ?? read('/entries/pages/', 'built', '_page', ['_layout', '_error']);
}

/** a route id's own folder and the folders above it (whose layouts it renders in), per form */
export function route_dirs(route: string): {
	own: (form: 'src' | 'built') => string;
	above: (form: 'src' | 'built') => string[];
} {
	const segs = route.split('/').filter(Boolean);
	const built = segs.map((s) => s.split('[').join('_').split(']').join('_'));
	const prefixes = (list: string[]) => list.map((_, i) => list.slice(0, i + 1).join('/'));
	const src_above = ['', ...prefixes(segs)];
	const built_above = ['', ...prefixes(built)];
	return {
		own: (form) => (form === 'src' ? segs : built).join('/'),
		above: (form) => (form === 'src' ? src_above : built_above)
	};
}

/** A file that is ANOTHER route's page or layout (not `route`'s own page, nor a layout above it):
 *  another visitor's request. `path` absolute, `file://`, or src-relative (`routes/x/+page.server.ts`).
 *  Endpoints and shared code are never another route's by this. */
export function another_routes_file(route: string, path: string): boolean {
	let p = path.startsWith('file://') ? path.slice('file://'.length) : path;
	if (p.startsWith('routes/')) p = '/src/' + p;
	else if (p.startsWith('src/routes/')) p = '/' + p;
	const f = route_file_of(p);
	if (!f) return false;
	const mine = route_dirs(route);
	return f.page ? f.dir !== mine.own(f.form) : !mine.above(f.form).includes(f.dir);
}
