/**
 * The cross-island context bridge (~4.7 kB) is gated OUT of apps that never provide context. Two
 * halves guard that: the driver's import-clause scan sets the `context` mark, and `resolveFeatures`
 * turns the mark into the bundled feature. The failure mode is silent (a missed provider drops
 * context inside islands at runtime), so this pins BOTH the include and — critically — the exclude.
 */
import { describe, expect, it } from 'vitest';
import {
	context_string_keys,
	source_uses_ogygia_context
} from '../src/compiler/link/context-detect.js';
import { resolveFeatures } from '../src/compiler/link/runtime-entry.js';

describe('source_uses_ogygia_context — a provider is detected', () => {
	it.each([
		[`import { setContext } from 'ogygia';`, 'drop-in setContext'],
		[`import { Provide } from 'ogygia';`, 'Provide'],
		[`import { createContext } from 'ogygia';`, 'createContext'],
		[`import { setContext as sc } from 'ogygia';`, 'aliased'],
		[`import { Region, setContext, preload } from "ogygia";`, 'among other named imports, dq'],
		[`import {\n  Provide,\n  createContext\n} from 'ogygia';`, 'multi-line clause'],
		[
			`import type { X } from 'ogygia';\nimport { setContext } from 'ogygia';`,
			'after a type import'
		],
		[`import * as og from 'ogygia';\nog.setContext('k', v);`, 'namespace usage']
	])('detects %s (%s)', (src) => {
		expect(source_uses_ogygia_context(src)).toBe(true);
	});
});

describe('source_uses_ogygia_context — no provider, no bridge', () => {
	it.each([
		[`import { getContext } from 'ogygia';`, 'read-only getContext needs no bridge'],
		[`import { setContext } from 'svelte';`, "svelte's setContext is same-root, not a bridge"],
		[`import { Region } from 'ogygia';`, 'a non-context ogygia import'],
		[`const setContext = 1; // just a name`, 'the bare word without an ogygia import'],
		[`import * as og from 'ogygia';\nog.preload(x);`, 'namespace import, non-context member'],
		['', 'empty file']
	])('ignores %s (%s)', (src) => {
		expect(source_uses_ogygia_context(src)).toBe(false);
	});

	it('is stateless across calls (g-flag lastIndex reset)', () => {
		const provider = `import { Provide } from 'ogygia';`;
		// Run twice in a row: a leaked lastIndex would make the second call miss.
		expect(source_uses_ogygia_context(provider)).toBe(true);
		expect(source_uses_ogygia_context(provider)).toBe(true);
	});
});

describe('context_string_keys — follows the getContext/setContext import binding, no text matching', () => {
	const reads = (src: string) => context_string_keys(src, 'script').reads;
	const sets = (src: string) => context_string_keys(src, 'script').sets;
	const svelteReads = (src: string) => context_string_keys(src, 'svelte').reads;

	it('counts a getContext read imported from svelte', () => {
		expect(reads(`import { getContext } from 'svelte';\nconst x = getContext('headingContext');`)).toEqual(
			['headingContext']
		);
	});

	it('counts a getContext read imported from ogygia', () => {
		expect(reads(`import { getContext } from 'ogygia';\ngetContext('theme');`)).toEqual(['theme']);
	});

	it('follows an alias (getContext as gc)', () => {
		expect(reads(`import { getContext as gc } from 'svelte';\ngc('cart');`)).toEqual(['cart']);
	});

	it('follows a namespace member (ns.getContext / ns.setContext)', () => {
		const src = `import * as svelte from 'svelte';\nsvelte.getContext('k');\nsvelte.setContext('s', 1);`;
		expect(context_string_keys(src, 'script')).toEqual({ reads: ['k'], sets: ['s'] });
	});

	it('reads inside a Svelte component <script>', () => {
		const src = `<script>\n  import { getContext } from 'svelte';\n  const first = getContext('headingContext')?.firstId;\n</script>\n<h1>{first}</h1>`;
		expect(svelteReads(src)).toEqual(['headingContext']);
	});

	it('separates a setContext (from svelte) into sets, not reads', () => {
		const src = `import { setContext, getContext } from 'svelte';\nsetContext('a', 1);\ngetContext('b');`;
		expect(context_string_keys(src, 'script')).toEqual({ reads: ['b'], sets: ['a'] });
	});

	it('does NOT count a getContext that is not imported from svelte/ogygia', () => {
		expect(reads(`import { getContext } from './my-utils.js';\ngetContext('nope');`)).toEqual([]);
	});

	it('does NOT count a local function named getContext', () => {
		expect(reads(`function getContext(k) { return k; }\ngetContext('local');`)).toEqual([]);
	});

	it('does NOT count a method call on an unrelated object', () => {
		expect(reads(`import { getContext } from 'svelte';\nsomeApi.getContext('other');`)).toEqual([]);
	});

	it('does NOT count a dynamic (non-literal) key', () => {
		expect(reads(`import { getContext } from 'svelte';\ngetContext(keyVar);`)).toEqual([]);
	});

	it('ignores the word in a comment or string (no import → no parse-time binding)', () => {
		expect(reads(`// getContext('faux') in a comment\nconst s = "getContext('also')";`)).toEqual([]);
		expect(sets(`// getContext('faux') in a comment\nconst s = "getContext('also')";`)).toEqual([]);
	});

	it('dedupes repeated reads of the same key', () => {
		expect(
			reads(`import { getContext } from 'svelte';\ngetContext('k');\nif (1) getContext('k');`)
		).toEqual(['k']);
	});

	it('unparseable source is a clean empty (no throw, no false warning)', () => {
		expect(context_string_keys(`import { getContext } from 'svelte';\nthis is not valid js (((`, 'script')).toEqual(
			{ reads: [], sets: [] }
		);
	});
});

describe('resolveFeatures — the mark gates the feature', () => {
	it('includes context only when the mark is set', () => {
		expect(resolveFeatures({ complete: true, hydrate: ['load'], context: true })).toContain(
			'context'
		);
		expect(resolveFeatures({ complete: true, hydrate: ['load'] })).not.toContain('context');
	});

	it('includes context under kitchen-sink (incomplete marks) — the safe default', () => {
		expect(resolveFeatures({ complete: false })).toContain('context');
	});
});
