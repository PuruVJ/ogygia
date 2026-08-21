import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientBuildWillSkip, read_csr, KEEP_CLIENT_DIR } from '../src/compiler/kit.js';

// ─────────────────────────────────────────────────────────────────────────────
// The Kit client-build skip predicate — the issue #4/#1 regression suite.
//
// Kit skips its client build when EVERY route node's CHAIN-RESOLVED `page_options.csr` is `false`
// (`manifest_data.nodes.every(n => n.page_options?.csr === false)`, static analysis inherits layout
// options down to children). ogygia must predict that exact condition to know when to inject the
// keepalive layout; predicting "no skip" while Kit skips = the runtime `<script src>` 404s.
// ─────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Materialize a routes tree: `{ 'a/+page.svelte': '...contents' }` → tmp routes dir. */
function routes(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'og-csr-'));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

describe('clientBuildWillSkip — chain-resolved csr (Kit parity)', () => {
	it('the fresh-app shape (issue #4): csr=false in the ROOT LAYOUT ONLY, option-less pages → skip', () => {
		const dir = routes({
			'+layout.svelte': '<slot />',
			'+layout.ts': 'export const csr = false;',
			'+page.svelte': '<h1>home</h1>',
			'about/+page.svelte': '<h1>about</h1>'
		});
		expect(clientBuildWillSkip(dir)).toBe(true);
	});

	it('one deep csr=true page under a csr=false root keeps the build alive', () => {
		const dir = routes({
			'+layout.ts': 'export const csr = false;',
			'+page.svelte': '<h1>home</h1>',
			'kit/+page.svelte': '<h1>kit</h1>',
			'kit/+page.ts': 'export const csr = true;'
		});
		expect(clientBuildWillSkip(dir)).toBe(false);
	});

	it('a csr=true MID-LAYOUT re-scopes its subtree (chain override, both directions)', () => {
		const dir = routes({
			'+layout.ts': 'export const csr = false;',
			'+page.svelte': '<h1>home</h1>',
			'app/+layout.ts': 'export const csr = true;',
			'app/+page.svelte': '<h1>app</h1>'
		});
		expect(clientBuildWillSkip(dir)).toBe(false);
	});

	it('all pages csr=false but the root LAYOUT NODE unset → Kit does NOT skip (node ≠ false)', () => {
		const dir = routes({
			'+layout.svelte': '<slot />',
			'+page.svelte': '<h1>home</h1>',
			'+page.ts': 'export const csr = false;',
			'about/+page.svelte': '<h1>about</h1>',
			'about/+page.ts': 'export const csr = false;'
		});
		expect(clientBuildWillSkip(dir)).toBe(false);
	});

	it('every node explicitly csr=false (layout AND pages) → skip (the adapters-fixture shape)', () => {
		const dir = routes({
			'+layout.ts': 'export const csr = false;',
			'+page.svelte': '<h1>home</h1>',
			'+page.ts': 'export const csr = false;'
		});
		expect(clientBuildWillSkip(dir)).toBe(true);
	});

	it('an option-file-only dir (bare `+layout.ts`, no .svelte) still scopes its children', () => {
		const dir = routes({
			'+layout.ts': 'export const csr = false;',
			'(group)/+layout.ts': 'export const csr = false;',
			'(group)/docs/+page.svelte': '<h1>docs</h1>'
		});
		expect(clientBuildWillSkip(dir)).toBe(true);
	});

	it('the injected keepalive dir is invisible to the prediction', () => {
		const dir = routes({
			'+layout.ts': 'export const csr = false;',
			'+page.svelte': '<h1>home</h1>',
			[`${KEEP_CLIENT_DIR}/+layout.ts`]: 'export const csr = true;'
		});
		expect(clientBuildWillSkip(dir)).toBe(true);
	});

	it('server option file beats nothing, universal beats server (Kit merge order)', () => {
		const dir = routes({
			'+layout.server.ts': 'export const csr = false;',
			'+layout.ts': 'export const csr = true;',
			'+page.svelte': '<h1>home</h1>'
		});
		expect(clientBuildWillSkip(dir)).toBe(false);
	});

	it('missing routes dir → never predicts a skip', () => {
		expect(clientBuildWillSkip(join(tmpdir(), 'og-csr-definitely-missing'))).toBe(false);
	});
});

describe('read_csr — export shapes', () => {
	it('reads the TS-annotated form `export const csr: boolean = false`', () => {
		const dir = routes({ '+layout.ts': 'export const csr: boolean = false;\n' });
		expect(read_csr(join(dir, '+layout.ts'))).toBe(false);
		const dir2 = routes({ '+layout.ts': 'export const csr : boolean = true;\n' });
		expect(read_csr(join(dir2, '+layout.ts'))).toBe(true);
	});

	it('a COMMENTED-OUT csr export does not win over the real one (regression)', () => {
		// Line comment above the real export — the real `false` must win, not the commented `true`.
		const dir = routes({ '+layout.ts': '// export const csr = true\nexport const csr = false;\n' });
		expect(read_csr(join(dir, '+layout.ts'))).toBe(false);
		// Block comment.
		const dir2 = routes({
			'+layout.ts': '/* export const csr = true */\nexport const csr = false;\n'
		});
		expect(read_csr(join(dir2, '+layout.ts'))).toBe(false);
		// A `://` inside a string on another line must not be mistaken for a comment and eat the export.
		const dir3 = routes({
			'+layout.ts': 'const u = "https://x.test";\nexport const csr = false;\n'
		});
		expect(read_csr(join(dir3, '+layout.ts'))).toBe(false);
	});
});
