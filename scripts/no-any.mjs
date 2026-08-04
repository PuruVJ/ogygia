// Zero-`any` enforcement gate (no eslint in the toolchain). Scans the library source for
// TYPE-position `any` — annotations, casts, generics, arrays — and fails the build if any
// are found. Deliberately NOT matching the English word "any" in prose/comments.
//
// The `types.d.ts` ambient file is exempt (it declares external/DOM contracts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC_GLOBS = ['packages/ogygia/src'];
const EXTS = ['.ts', '.svelte'];
const EXEMPT = /types\.d\.ts$/;

// TYPE-position `any` only: `: any`, `as any`, `<any` (generic), `any>` (generic close),
// `any[]` (array). Word boundaries keep it off identifiers like `anyOf` / `many`.
const TYPE_ANY = /:\s*any\b|\bas\s+any\b|<\s*any\b|\bany\s*>|\bany\[\]/;

const offenders = [];

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name === 'dist') continue;
			walk(full);
		} else if (EXTS.some((x) => e.name.endsWith(x)) && !EXEMPT.test(full)) {
			const lines = readFileSync(full, 'utf-8').split('\n');
			lines.forEach((line, i) => {
				if (TYPE_ANY.test(line)) offenders.push(`${full}:${i + 1}: ${line.trim()}`);
			});
		}
	}
}

for (const g of SRC_GLOBS) {
	const abs = join(root, g);
	try {
		statSync(abs);
		walk(abs);
	} catch {
		/* glob may not exist (pre/post rename) */
	}
}

if (offenders.length) {
	console.error(`[no-any] ${offenders.length} type-position \`any\` found (use precise types):`);
	for (const o of offenders) console.error('  ' + o);
	process.exit(1);
}
console.log('[no-any] OK — no type-position `any` in library src.');
