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

/**
 * THE APP MODULES A SERVER FILE IMPORTS: each `$lib/…` or relative import of a script module
 * (`.svelte` files and packages left out), src-relative and resolved against the file's folder —
 * the candidates to read, each as written (no extension) and with `.ts` / `.js` / `/index.ts` /
 * `/index.js`. One file's `import … from '…'` and `export … from '…'` lines; no regex.
 */
export function module_imports(file: string, src: string): string[] {
	const dir = file.slice(0, file.lastIndexOf('/'));
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of src.split('\n')) {
		const t = line.trim();
		if (!(t.startsWith('import') || t.startsWith('export') || t.startsWith('}') || t.startsWith("'") || t.startsWith('"'))) continue;
		for (const q of ["'", '"']) {
			const a = line.indexOf(q);
			const b = a === -1 ? -1 : line.indexOf(q, a + 1);
			if (b === -1) continue;
			const spec = line.slice(a + 1, b);
			if (spec.endsWith('.svelte') || !(spec.startsWith('$lib/') || spec.startsWith('./') || spec.startsWith('../'))) continue;
			let base: string;
			if (spec.startsWith('$lib/')) base = 'lib/' + spec.slice(5);
			else {
				const parts = dir ? dir.split('/') : [];
				for (const seg of spec.split('/')) {
					if (seg === '..') parts.pop();
					else if (seg !== '.') parts.push(seg);
				}
				base = parts.join('/');
			}
			// (`./x.js` written for a `.ts` file: the TypeScript convention)
			const stem = base.endsWith('.js') ? base.slice(0, -3) : base;
			for (const c of base.endsWith('.ts') ? [base] : [stem + '.ts', stem + '.js', base, stem + '/index.ts', stem + '/index.js'])
				if (!seen.has(c)) {
					seen.add(c);
					out.push(c);
				}
			break;
		}
	}
	return out;
}
