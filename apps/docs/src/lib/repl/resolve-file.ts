// Resolve an import specifier to a workspace file KEY (the file map is keyed by path). The Observatory
// has no real module graph — just a flat `{ path: source }` map — so this is deliberately lenient: it
// prefers an exact path but falls back to matching by filename, which is what lets you drag a file to a
// new folder without rewriting every import of it (the name is the anchor, not the path).
//
// Kit aliases: `$lib/x` (Kit ≤2) and `#lib/x` (Kit 3 moves to Node subpath imports) BOTH mean
// `src/lib/x`. Both expand to the exact path first, so an aliased import resolves unambiguously even
// when another file elsewhere happens to share its basename.
//
// The one hazard of name-matching is two files with the SAME basename in different folders. Rather than
// return whichever Object.keys order happens to yield (arbitrary), disambiguate by the longest trailing
// path overlap with the (alias-expanded) specifier — so `$lib/ui/Btn.svelte` picks `src/lib/ui/Btn.svelte`
// over `src/other/Btn.svelte` — then the shortest path, then lexical order, as stable tiebreaks.

export function resolve_file(spec: string, files: Record<string, string>): string | null {
	const clean = spec.split('?')[0];
	// $lib and #lib → src/lib (only as a leading segment: `$libfoo` is not the alias).
	const aliased = clean.replace(/^[$#]lib(?=\/|$)/, 'src/lib');
	const bare = aliased.replace(/^\.\//, '').replace(/^\//, '');

	// 1. Exact path (alias-expanded) — the unambiguous answer, always preferred.
	if (files[bare] != null) return bare;
	if (files[aliased] != null) return aliased;

	// 2. Basename fallback — lenient, so a moved file is still found by name.
	const wantParts = bare.split('/').filter(Boolean);
	const base = wantParts[wantParts.length - 1];
	if (!base) return null;
	if (files[base] != null) return base;

	const matches = Object.keys(files).filter((k) => k.split('/').pop() === base);
	if (matches.length <= 1) return matches[0] ?? null;

	// Ambiguous basename: rank by how much of the trailing path matches what was asked for.
	const overlap = (k: string): number => {
		const kp = k.split('/').filter(Boolean);
		let i = 0;
		while (i < kp.length && i < wantParts.length && kp[kp.length - 1 - i] === wantParts[wantParts.length - 1 - i]) i++;
		return i;
	};
	return matches
		.slice()
		.sort((a, b) => overlap(b) - overlap(a) || a.length - b.length || (a < b ? -1 : 1))[0];
}
