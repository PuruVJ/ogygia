/**
 * The cross-island context bridge (~4.7 kB) is gated OUT of apps that never provide context. Two
 * halves guard that: the driver's import-clause scan sets the `context` mark, and `resolveFeatures`
 * turns the mark into the bundled feature. The failure mode is silent (a missed provider drops
 * context inside islands at runtime), so this pins BOTH the include and — critically — the exclude.
 */
import { describe, expect, it } from 'vitest';
import { source_uses_ogygia_context } from '../src/compiler/link/context-detect.js';
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
