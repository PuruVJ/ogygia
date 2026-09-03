// Duplicate-import dedup (task 5): when the SAME component is imported twice with different
// strategies, each usage becomes its own island virtual module — but the component's compiled code
// must ship in exactly ONE client chunk (Rolldown shares it between the two island entry chunks),
// never duplicated. Inspected in Kit's built playground client output (/dup demo).
//
// (An all-csr=false variant used to build a fixture via the library's own standalone client build;
// that build was replaced by the boot-route mechanism — Kit's NORMAL client build now handles the
// all-csr=false case, so there is no separate build path to dedup-check here.)
// A build-output inspector — no server needed. Usage: pnpm exec playwright test dedup
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check } from './fixtures/index.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));

/** Every .js chunk under a client output dir that contains `marker`. */
function chunks_with(dir: string, marker: string): string[] {
	const hits: string[] = [];
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(marker))
				hits.push(path.relative(dir, f));
		}
	};
	walk(dir);
	return hits;
}

test.describe('same-component-two-strategies → ONE client chunk', () => {
	test('(A) Kit-driven: the already-built playground client output', () => {
		const client_dir = path.join(
			repo,
			'apps/playground',
			'.svelte-kit',
			'output',
			'client',
			'_app',
			'immutable'
		);
		const marker = 'dup-widget-unique-marker-9c3f';
		if (!fs.existsSync(client_dir)) {
			check(
				'kit-driven: playground client build present (run `pnpm --filter playground build`)',
				false,
				client_dir
			);
		} else {
			const hits = chunks_with(client_dir, marker);
			check(
				'kit-driven: the dup component is emitted (marker found)',
				hits.length >= 1,
				`${hits.length} chunk(s)`
			);
			check(
				'kit-driven: dup component code in EXACTLY ONE chunk (not duplicated)',
				hits.length === 1,
				hits.join(', ') || '(none)'
			);
		}
	});
});
