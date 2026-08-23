// Unit tests for the Observatory's import → workspace-key resolver (src/lib/repl/resolve-file.ts).
// Covers the Kit alias forms ($lib AND #lib for Kit 3), the exact-path preference, the move-tolerant
// basename fallback, and the duplicate-basename disambiguation (the hazard the resolver must not
// resolve arbitrarily). Node strips the .ts types natively.
import { resolve_file } from './resolve-file.ts';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (label, got, want) => ok(label + `  (→ ${JSON.stringify(got)})`, got === want, `wanted ${JSON.stringify(want)}`);

console.log('resolve-file\n');

const demo = {
	'src/routes/+page.svelte': 'x',
	'src/lib/Counter.svelte': 'x',
	'src/lib/Header.svelte': 'x'
};

// ── exact + relative ──
eq('exact key', resolve_file('src/lib/Counter.svelte', demo), 'src/lib/Counter.svelte');
eq('./ prefix strips to a root key', resolve_file('./+page.svelte', { '+page.svelte': 'x' }), '+page.svelte');
eq('leading / strips', resolve_file('/src/lib/Counter.svelte', demo), 'src/lib/Counter.svelte');
eq('query string is ignored', resolve_file('src/lib/Counter.svelte?raw', demo), 'src/lib/Counter.svelte');

// ── $lib alias (Kit <=2) ──
eq('$lib/ maps to src/lib/', resolve_file('$lib/Counter.svelte', demo), 'src/lib/Counter.svelte');
eq('$lib/ nested', resolve_file('$lib/Header.svelte', demo), 'src/lib/Header.svelte');

// ── #lib alias (Kit 3) ──
eq('#lib/ maps to src/lib/ (Kit 3)', resolve_file('#lib/Counter.svelte', demo), 'src/lib/Counter.svelte');
eq('$libfoo is NOT the alias', resolve_file('$libfoo/Counter.svelte', demo), 'src/lib/Counter.svelte'); // still found by basename fallback

// ── move-tolerant basename fallback ──
{
	const moved = { 'src/routes/+page.svelte': 'x', 'Counter.svelte': 'x' }; // Counter dragged to root
	eq('$lib import of a file moved to root still resolves by name', resolve_file('$lib/Counter.svelte', moved), 'Counter.svelte');
	eq('#lib import of a moved file resolves by name', resolve_file('#lib/Counter.svelte', moved), 'Counter.svelte');
	eq('relative import of a moved file resolves by name', resolve_file('../lib/Counter.svelte', moved), 'Counter.svelte');
}

// ── duplicate basename: disambiguate by trailing-path overlap, NOT arbitrary key order ──
{
	const dup = {
		'src/other/Button.svelte': 'OTHER',
		'src/lib/ui/Button.svelte': 'LIB',
		'src/lib/Button.svelte': 'LIBROOT'
	};
	eq('$lib/ui/Button prefers the src/lib/ui match (exact)', resolve_file('$lib/ui/Button.svelte', dup), 'src/lib/ui/Button.svelte');
	// no exact match for this one → fall back, prefer the longest trailing overlap (ui/Button)
	const partial = {
		'src/other/Button.svelte': 'OTHER',
		'src/components/ui/Button.svelte': 'UI'
	};
	eq('ambiguous basename picks the best trailing-path overlap', resolve_file('$lib/ui/Button.svelte', partial), 'src/components/ui/Button.svelte');
	// pure basename tie (no path hint beyond the name) → deterministic: shortest path then lexical
	const tie = { 'b/X.svelte': 'x', 'a/X.svelte': 'x', 'aa/X.svelte': 'x' };
	const got = resolve_file('$lib/X.svelte', tie);
	eq('a bare-name tie resolves deterministically (shortest, then lexical)', got, 'a/X.svelte');
	// same call twice is stable
	ok('duplicate resolution is stable across calls', resolve_file('$lib/X.svelte', tie) === resolve_file('$lib/X.svelte', tie));
}

// ── misses ──
eq('unknown specifier → null', resolve_file('$lib/Nope.svelte', demo), null);
eq('empty-ish spec → null', resolve_file('', demo), null);
eq('external package → null (handled elsewhere)', resolve_file('nanoid', demo), null);

console.log(`\n${'─'.repeat(44)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
