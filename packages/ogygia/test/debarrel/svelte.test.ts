/**
 * Svelte importers: script blocks found by the Svelte parser (never a regex over markup), both
 * `<script>` and `<script module>`, `lang="ts"`, and the traps — a `<script>` inside `{@html}` or a
 * template string, a component with no script, a syntax error, a region-marked import.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './_fixture.js';

let f: Fixture;
afterEach(() => f?.dispose());

const lib = () => ({
	'lib/Button.svelte': '<button>x</button>',
	'lib/util.ts': 'export const util = 1; export type T = 1;',
	'lib/index.ts': `export { default as Button } from './Button.svelte';\nexport { util, type T } from './util';`
});

describe('rewrite_svelte', () => {
	it('rewrites the instance script and leaves the markup byte-identical', async () => {
		f = fixture({
			...lib(),
			'src/App.svelte': `<script lang="ts">\n\timport { Button, util } from '$lib';\n\tlet n: number = util;\n</script>\n\n<Button>{n}</Button>\n<p>{@html '<script>alert(1)</script>'}</p>\n`
		});
		expect(await f.rewrite('src/App.svelte')).toBe(
			`<script lang="ts">\n\timport Button from '${f.id('lib/Button.svelte')}';\nimport { util } from '${f.id('lib/util.ts')}';\n\tlet n: number = util;\n</script>\n\n<Button>{n}</Button>\n<p>{@html '<script>alert(1)</script>'}</p>\n`
		);
	});

	it('rewrites the module script too, and both when present; attributes ride along', async () => {
		f = fixture({
			...lib(),
			'src/App.svelte': `<script module>\n\timport { util } from '$lib';\n\texport const meta = util;\n</script>\n<script>\n\timport { Button } from '$lib' with { type: 'x' };\n</script>\n<Button />`
		});
		expect(await f.rewrite('src/App.svelte')).toBe(
			`<script module>\n\timport { util } from '${f.id('lib/util.ts')}';\n\texport const meta = util;\n</script>\n<script>\n\timport Button from '${f.id('lib/Button.svelte')}' with { type: 'x' };\n</script>\n<Button />`
		);
	});

	it('a region-marked import in a component is left alone under the skip policy; the unmarked one next to it moves', async () => {
		f = fixture({
			...lib(),
			'src/App.svelte': `<script>\n\timport { Button } from '$lib' with { wake: 'visible' };\n\timport { util } from '$lib';\n</script>\n<Button>{util}</Button>`
		});
		const skip = (decl: { attribute_keys: string[] }) => decl.attribute_keys.includes('wake');
		expect(await f.rewrite('src/App.svelte', undefined, { skip })).toBe(
			`<script>\n\timport { Button } from '$lib' with { wake: 'visible' };\n\timport { util } from '${f.id('lib/util.ts')}';\n</script>\n<Button>{util}</Button>`
		);
	});

	it('`lang="ts"` types in the script do not break the parse (satisfies, generics, `as const`)', async () => {
		f = fixture({
			...lib(),
			'src/App.svelte': `<script lang="ts">\n\timport { util, type T } from '$lib';\n\tconst x = { a: 1 } satisfies Record<string, T>;\n\tlet y = $state<T[]>([] as const as T[]);\n</script>`
		});
		expect(await f.rewrite('src/App.svelte')).toBe(
			`<script lang="ts">\n\timport { util, type T } from '${f.id('lib/util.ts')}';\n\tconst x = { a: 1 } satisfies Record<string, T>;\n\tlet y = $state<T[]>([] as const as T[]);\n</script>`
		);
	});

	it('import-looking text in a template string, a comment, and the markup is never rewritten', async () => {
		f = fixture({
			...lib(),
			'src/App.svelte': `<script>\n\timport { util } from '$lib';\n\t// import { Button } from '$lib';\n\tconst s = \`<script>import { Button } from '$lib';\`;\n</script>\n<pre>{s}</pre>\n<p>{@html "<script>import { Button } from '$lib';</script>"}</p>`
		});
		const out = (await f.rewrite('src/App.svelte'))!;
		expect(out).toContain(`import { util } from '${f.id('lib/util.ts')}';`);
		expect(out).toContain(`// import { Button } from '$lib';`);
		expect(out).toContain(`const s = \`<script>import { Button } from '$lib';\`;`);
		expect(out).toContain(`{@html "<script>import { Button } from '$lib';</script>"}`);
		expect(out).not.toContain('Button.svelte');
	});

	it('no script, a component that imports no barrel, and a syntax error all leave the file alone', async () => {
		f = fixture({
			...lib(),
			'src/None.svelte': `<p>hello</p>`,
			'src/Plain.svelte': `<script>import { x } from './x.js';</script>`,
			'src/Broken.svelte': `<script>import { from '$lib';</script>`,
			'src/Unclosed.svelte': `<script>import { util } from '$lib';\n<div>`,
			'src/x.js': 'export const x = 1;'
		});
		expect(await f.rewrite('src/None.svelte')).toBeNull();
		expect(await f.rewrite('src/Plain.svelte')).toBeNull();
		expect(await f.rewrite('src/Broken.svelte')).toBeNull();
		expect(await f.rewrite('src/Unclosed.svelte')).toBeNull();
	});

	it('a `.svelte.ts` module goes through the plain rewriter', async () => {
		f = fixture({ ...lib(), 'src/state.svelte.ts': `import { util } from '$lib';\nexport const n = $state(util);` });
		expect(await f.rewrite('src/state.svelte.ts')).toBe(`import { util } from '${f.id('lib/util.ts')}';\nexport const n = $state(util);`);
	});

	it('a barrel that re-exports a Svelte component through a nested barrel still lands on the .svelte file', async () => {
		f = fixture({
			'lib/atoms/Button.svelte': '<button/>',
			'lib/atoms/index.ts': `export { default as Button } from './Button.svelte';`,
			'lib/index.ts': `export * from './atoms';`,
			'src/App.svelte': `<script>import { Button } from '$lib';</script><Button/>`
		});
		expect(await f.rewrite('src/App.svelte')).toBe(`<script>import Button from '${f.id('lib/atoms/Button.svelte')}';</script><Button/>`);
	});
});
