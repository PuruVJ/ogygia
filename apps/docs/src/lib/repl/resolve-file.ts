// Resolve an import specifier to a workspace file KEY (the file map is keyed by path). The Observatory
// has no real module graph — just a flat `{ path: source }` map — so this is deliberately lenient: it
// prefers an exact path but falls back to matching by filename, which is what lets you drag a file to a
// new folder without rewriting every import of it (the name is the anchor, not the path).
//
// Kit aliases are a DIRECT, exact mapping, not a search: `$lib/x` (Kit ≤2) and `#lib/x` (Kit 3 moves to
// Node subpath imports) both mean `src/lib/x`. So an aliased import resolves to exactly that path — it
// never wanders into `src/elsewhere/x` because some other file shares the basename.
//
// Only the BASENAME FALLBACK is fuzzy, and only because a dragged/moved file must still be found by
// name. That fallback is genuinely ambiguous when two files share a basename; rather than return
// whichever Object.keys order happens to yield, it picks deterministically — shortest path first (the
// most root-ish / least nested), then lexical. There's no "correct" answer there, so it's honest about
// being a stable guess, not clever.

export function resolve_file(spec: string, files: Record<string, string>): string | null {
	const clean = spec.split('?')[0];
	// $lib and #lib → src/lib (only as a leading segment: `$libfoo` is not the alias).
	const aliased = clean.replace(/^[$#]lib(?=\/|$)/, 'src/lib');
	const bare = aliased.replace(/^\.\//, '').replace(/^\//, '');

	// 1. Exact path (alias-expanded) — the convention answer, and the normal case.
	if (files[bare] != null) return bare;
	if (files[aliased] != null) return aliased;

	// 2. Basename fallback — lenient, so a file moved to a new folder is still found by name.
	const base = bare.split('/').pop();
	if (!base) return null;
	if (files[base] != null) return base; // a root file named exactly this wins (shortest path)
	const matches = Object.keys(files).filter((k) => k.split('/').pop() === base);
	if (matches.length <= 1) return matches[0] ?? null;
	// Ambiguous basename: deterministic, not arbitrary — shortest path, then lexical.
	return matches.slice().sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
}
