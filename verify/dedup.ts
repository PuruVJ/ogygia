// Duplicate-import dedup (task 5): when the SAME component is imported twice with different
// strategies, each usage becomes its own island virtual module — but the component's compiled code
// must ship in exactly ONE client chunk (Rolldown shares it between the two island entry chunks),
// never duplicated. Verified in BOTH build modes:
//   - Kit-driven: inspect the already-built playground client output (/dup demo).
//   - standalone (all-csr=false): build a minimal fixture via the library's own standalone client
//     build and inspect its output.
// A build-output inspector — no server needed. Usage: node verify/dedup.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ogygia } from '../packages/ogygia/dist/vite/index.js';
import { runStandaloneClientBuild } from '../packages/ogygia/dist/vite/standalone.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

/** Every .js chunk under a client output dir that contains `marker`. */
function chunksWith(dir: string, marker: string): string[] {
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
			else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(marker)) hits.push(path.relative(dir, f));
		}
	};
	walk(dir);
	return hits;
}

// ---------- (A) Kit-driven: the already-built playground client output ----------
{
	const clientDir = path.join(repo, 'playground', '.svelte-kit', 'output', 'client', '_app', 'immutable');
	const marker = 'dup-widget-unique-marker-9c3f';
	if (!fs.existsSync(clientDir)) {
		check('kit-driven: playground client build present (run `pnpm --filter playground build`)', false, clientDir);
	} else {
		const hits = chunksWith(clientDir, marker);
		check('kit-driven: the dup component is emitted (marker found)', hits.length >= 1, `${hits.length} chunk(s)`);
		check('kit-driven: dup component code in EXACTLY ONE chunk (not duplicated)', hits.length === 1, hits.join(', ') || '(none)');
	}
}

// ---------- (B) standalone: build a minimal all-csr=false fixture ----------
{
	const root = path.join(repo, 'playground', 'dedup-fixture');
	const outDir = path.join(repo, 'playground', '.dedup-standalone-out');
	const marker = 'standalone-dedup-marker-7b21';
	fs.rmSync(outDir, { recursive: true, force: true });
	try {
		const { runtimeFileName } = await runStandaloneClientBuild({
			root,
			base: '/',
			clientDir: outDir,
			sourcemap: false,
			makePlugin: (opts: Record<string, unknown>) => ogygia({ ...opts })
		});
		check('standalone: build produced a hashed runtime chunk', !!runtimeFileName, String(runtimeFileName));
		const immutable = path.join(outDir, '_app', 'immutable');
		const hits = chunksWith(immutable, marker);
		check('standalone: the dup component is emitted (marker found)', hits.length >= 1, `${hits.length} chunk(s)`);
		check('standalone: dup component code in EXACTLY ONE chunk (not duplicated)', hits.length === 1, hits.join(', ') || '(none)');
	} catch (e) {
		check('standalone: build succeeded', false, (e as Error).message.slice(0, 120));
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL DEDUP CHECKS PASSED' : failures + ' DEDUP CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
