/**
 * THE `<Name>.svelte` A ROUTE IMPORTS: from its `+page.svelte` / `+layout.svelte` files (src-relative
 * paths), each import of a file with that name, resolved: `$lib/hell/X.svelte` → `lib/hell/X.svelte`,
 * `./X.svelte` beside the route file. What tells two same-named components apart (a component is
 * named after its file, and a `Button.svelte` can live in several folders).
 */
export function route_imports(
	files: Iterable<string>,
	read: (file: string) => string | undefined,
	name: string
): Set<string> {
	const out = new Set<string>();
	const leaf = `/${name}.svelte`;
	for (const file of files) {
		if (!file.endsWith('/+page.svelte') && !file.endsWith('/+layout.svelte')) continue;
		const src = read(file);
		if (!src) continue;
		const dir = file.slice(0, file.lastIndexOf('/'));
		// an import spread over lines (`import X from` / `  '$lib/X.svelte'`, `} from '…'`): the spec
		// line has `from`, or follows a line that ends with it
		let after_from = false;
		for (const line of src.split('\n')) {
			const t = line.trim();
			const was_after = after_from;
			if (t) after_from = t.endsWith('from') || t === 'import';
			if (!line.includes(leaf)) continue;
			if (!was_after && !line.includes('import') && !line.includes('from')) continue;
			for (const q of ["'", '"']) {
				const end = line.indexOf(`${leaf}${q}`);
				if (end === -1) continue;
				const start = line.lastIndexOf(q, end) + 1;
				const spec = line.slice(start, end + leaf.length);
				if (spec.startsWith('$lib/')) out.add('lib/' + spec.slice(5));
				else if (spec.startsWith('.')) {
					// `./X` / `../x/X` against the route file's folder
					const parts = dir.split('/');
					for (const seg of spec.split('/')) {
						if (seg === '..') parts.pop();
						else if (seg !== '.') parts.push(seg);
					}
					out.add(parts.join('/'));
				}
			}
		}
	}
	return out;
}
