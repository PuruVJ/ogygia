/**
 * The JS→TS converter — the full site-kit `convert_to_ts` port, tested through its PUBLIC contract
 * (the `js_to_ts()` VariantGenerator): every JSDoc shape the svelte.dev corpus uses, the type-import
 * collection, the named throws, and the fence-claiming rules.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { js_to_ts } from '../src/lib/markdown/js-to-ts.ts';
import type { Fence, Variant } from 'ogygia/content/markdown';

const gen = js_to_ts();
beforeAll(() => gen.ready!());

const fence = (source: string, lang = 'js'): Fence => ({ lang, raw_meta: '', meta: {}, source });

/** Run the generator; return the TS variant's source (or null when unclaimed / single-language). */
function ts_of(source: string, lang = 'js'): string | null {
	const variants = gen.generate(fence(source, lang));
	if (!variants || variants.length < 2) return null;
	const ts = variants.find((v: Variant) => v.value === 'ts')!;
	return ts.fence.source;
}

// ── @type on variables ──────────────────────────────────────────────────────────

describe('@type on variable statements', () => {
	it('annotates a let', () => {
		const out = ts_of(`/** @type {number} */\nlet count;`);
		expect(out).toBe(`let count: number;`);
	});

	it('annotates a const with an initializer', () => {
		const out = ts_of(`/** @type {string[]} */\nconst names = [];`);
		expect(out).toBe(`const names: string[] = [];`);
	});

	it('collects import(…) types into an import type statement', () => {
		const out = ts_of(`/** @type {import('./$types').PageServerLoad} */\nlet load_fn;`);
		expect(out).toContain(`import type { PageServerLoad } from './$types';`);
		expect(out).toContain(`let load_fn: PageServerLoad;`);
		expect(out).not.toContain(`import('./$types')`);
	});

	it('keeps generic arguments on imported types', () => {
		const out = ts_of(`/** @type {import('svelte').Component<{ name: string }>} */\nlet C;`);
		expect(out).toContain(`import type { Component } from 'svelte';`);
		expect(out).toContain(`let C: Component<{ name: string }>;`);
	});

	it('dedupes imports from the same module across declarations', () => {
		const out = ts_of(
			`/** @type {import('./$types').PageLoad} */\nlet a;\n/** @type {import('./$types').ActionData} */\nlet b;`
		);
		expect(out!.match(/import type/g)!.length).toBe(1);
		expect(out).toContain(`import type { PageLoad, ActionData } from './$types';`);
	});

	it('appends the type import after an existing import', () => {
		const out = ts_of(`import { writable } from 'svelte/store';\n\n/** @type {import('./x').T} */\nlet v;`);
		const import_order = out!.indexOf(`from 'svelte/store'`) < out!.indexOf(`import type { T }`);
		expect(import_order).toBe(true);
	});
});

// ── @type / @satisfies on function declarations (the state-management shapes) ──

describe('@type on function declarations', () => {
	it('rewrites an exported function to a typed const arrow', () => {
		const out = ts_of(
			`/** @type {import('./$types').PageServerLoad} */\nexport function load() {\n\treturn { user };\n}`
		);
		expect(out).toContain(`export const load: PageServerLoad = () => {`);
		expect(out).toContain(`import type { PageServerLoad } from './$types';`);
		expect(out!.trimEnd().endsWith('};')).toBe(true);
		expect(out).not.toContain('@type');
	});

	it('preserves async on the arrow', () => {
		const out = ts_of(`/** @type {import('./x').Fn} */\nexport async function go() {\n\treturn 1;\n}`);
		expect(out).toContain(`export const go: Fn = async () => {`);
	});

	it('converts a non-exported function too', () => {
		const out = ts_of(`/** @type {import('./x').Fn} */\nfunction go() {\n\treturn 1;\n}`);
		expect(out).toContain(`const go: Fn = () => {`);
		expect(out).not.toContain('export const');
	});
});

describe('@satisfies', () => {
	it('appends satisfies to a const object (the actions shape)', () => {
		const out = ts_of(
			`/** @satisfies {import('./$types').Actions} */\nexport const actions = {\n\tdefault: async ({ request }) => {}\n};`
		);
		expect(out).toContain(`} satisfies Actions;`);
		expect(out).toContain(`import type { Actions } from './$types';`);
		expect(out).not.toContain('@satisfies');
	});

	it('wraps a function declaration in parens with satisfies', () => {
		const out = ts_of(`/** @satisfies {import('./x').Fn} */\nexport function go() {\n\treturn 1;\n}`);
		expect(out).toContain(`export const go = (() => {`);
		expect(out!.trimEnd().endsWith(`}) satisfies Fn;`)).toBe(true);
	});

	it('throws on @type combined with @satisfies', () => {
		expect(() =>
			gen.generate(fence(`/** @type {A} @satisfies {B} */\nexport function go() {}`))
		).toThrow('Cannot combine @type and @satisfies');
	});
});

// ── @param / @returns ───────────────────────────────────────────────────────────

describe('@param / @returns', () => {
	it('annotates parameters and return type in place (no const conversion)', () => {
		const out = ts_of(
			`/**\n * @param {string} name\n * @param {number} age\n * @returns {string}\n */\nexport function greet(name, age) {\n\treturn name;\n}`
		);
		expect(out).toContain(`export function greet(name: string, age: number): string {`);
	});

	it('annotates arrow-function property assignments', () => {
		const out = ts_of(
			`export const handlers = {\n\t/** @param {MouseEvent} event */\n\tclick: (event) => {}\n};`
		);
		expect(out).toContain(`click: (event: MouseEvent) => {}`);
	});

	it('annotates method declarations', () => {
		const out = ts_of(
			`const obj = {\n\t/** @param {string} id */\n\tfind(id) {\n\t\treturn id;\n\t}\n};`
		);
		expect(out).toContain(`find(id: string) {`);
	});

	it('throws on @type on a property method (site-kit named error)', () => {
		expect(() =>
			gen.generate(fence(`const o = {\n\t/** @type {import('./x').T} */\n\tgo: () => {}\n};`))
		).toThrow('@type on property methods does nothing');
	});
});

// ── casts ───────────────────────────────────────────────────────────────────────

describe('@type casts', () => {
	it('converts a parenthesized cast to as', () => {
		const out = ts_of(`const el = /** @type {HTMLElement} */ (event.target);`);
		expect(out).toBe(`const el = event.target as HTMLElement;`);
	});

	it('collects the cast type import', () => {
		const out = ts_of(`const c = /** @type {import('./x').Config} */ (raw);`);
		expect(out).toContain(`import type { Config } from './x';`);
		expect(out).toContain(`const c = raw as Config;`);
	});
});

// ── comment handling ────────────────────────────────────────────────────────────

describe('JSDoc comment handling', () => {
	it('keeps the comment text when a block has prose + a tag', () => {
		const out = ts_of(`/**\n * Greets the user.\n * @param {string} name\n */\nfunction greet(name) {}`);
		expect(out).toContain('Greets the user.');
		expect(out).not.toContain('@param');
		expect(out).toContain(`function greet(name: string) {}`);
	});

	it('removes a tags-only block entirely', () => {
		const out = ts_of(`/** @type {number} */\nlet n;`);
		expect(out).not.toContain('/**');
	});

	it('leaves a comment-only JSDoc untouched (nothing to convert)', () => {
		expect(ts_of(`/** Just documentation. */\nfunction go() {}`)).toBeNull();
	});
});

// ── file-name pre-passes ────────────────────────────────────────────────────────

describe('filename rewrites in the TS variant', () => {
	it('renames /// file: …js to .ts', () => {
		const out = ts_of(`/// file: +page.server.js\n/** @type {number} */\nlet n;`);
		expect(out).toContain(`/// file: +page.server.ts`);
	});

	it('renames // @filename: index.js to index.ts', () => {
		const out = ts_of(`// @filename: index.js\n/** @type {number} */\nlet n;`);
		expect(out).toContain(`// @filename: index.ts`);
	});
});

// ── claiming rules ──────────────────────────────────────────────────────────────

describe('fence claiming', () => {
	it('ignores non-js/svelte fences', () => {
		expect(gen.generate(fence('let a = 1;', 'ts'))).toBeNull();
		expect(gen.generate(fence('body { color: red }', 'css'))).toBeNull();
	});

	it('a js fence with nothing to convert stays single-language', () => {
		const variants = gen.generate(fence('const a = 1;'));
		expect(variants).toEqual([{ label: 'JS', value: 'js', fence: fence('const a = 1;') }]);
	});

	it('every plain-script svelte fence gets a lang="ts" variant (svelte.dev rule)', () => {
		const src = `<script>\n\tlet count = 0;\n</script>\n\n<button>{count}</button>`;
		const out = ts_of(src, 'svelte');
		expect(out).toContain(`<script lang="ts">`);
		expect(out).toContain(`let count = 0;`);
	});

	it('converts JSDoc inside a svelte script block', () => {
		const src = `<script>\n\t/** @type {import('./$types').PageProps} */\n\tlet { data } = $props();\n</script>`;
		const out = ts_of(src, 'svelte');
		expect(out).toContain(`<script lang="ts">`);
		expect(out).toContain(`let { data }: PageProps = $props();`);
		expect(out).toContain(`import type { PageProps } from './$types';`);
	});

	it('leaves a TS-authored svelte fence alone', () => {
		expect(ts_of(`<script lang="ts">\n\tlet a: number = 1;\n</script>`, 'svelte')).toBeNull();
	});

	it('leaves a svelte fence with no script alone', () => {
		expect(ts_of(`<p>hello</p>`, 'svelte')).toBeNull();
	});
});

// ── the exact state-management page fence (the reported bug, end to end) ────────

describe('the state-management regression fence', () => {
	const source = [
		`let user;`,
		``,
		`/** @type {import('./$types').PageServerLoad} */`,
		`export function load() {`,
		`\treturn { user };`,
		`}`,
		``,
		`/** @satisfies {import('./$types').Actions} */`,
		`export const actions = {`,
		`\tdefault: async ({ request }) => {`,
		`\t\tconst data = await request.formData();`,
		``,
		`\t\t// NEVER DO THIS!`,
		`\t\tuser = {`,
		`\t\t\tname: data.get('name'),`,
		`\t\t\tembarrassingSecret: data.get('secret')`,
		`\t\t};`,
		`\t}`,
		`}`
	].join('\n');

	it('claims the fence and produces the svelte.dev TS shape', () => {
		const out = ts_of(source);
		expect(out).not.toBeNull();
		expect(out).toContain(`import type { PageServerLoad, Actions } from './$types';`);
		expect(out).toContain(`export const load: PageServerLoad = () => {`);
		expect(out).toContain(`} satisfies Actions`);
		expect(out).toContain(`// NEVER DO THIS!`); // real comments survive
		expect(out).not.toContain('@type');
		expect(out).not.toContain('@satisfies');
	});
});
