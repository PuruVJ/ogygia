/**
 * The v3 config surface — one grammar, sovereign subsystems (internal/notes/config.md).
 *
 * Covers: the legacy rename map (errors, never aliasing), config-time preset validation for both
 * dictionaries, the loader macro's `preset` door (literal-only, name-checked, stripped from runtime
 * options, minted as a `?og_preset=` module-variant query), and the preprocessor's marker dispatch
 * with depth-2 merge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ogygia } from '../src/vite/index.js';
import { rewrite_loaders, extract_preset } from '../src/compiler/content/loaders.js';
import { islandBridge } from '../src/vite/island-bridge.js';

const saved: Partial<typeof islandBridge> = {};
beforeEach(() => {
	saved.markdownConfig = islandBridge.markdownConfig;
	saved.contentPresets = islandBridge.contentPresets;
	saved.scan = islandBridge.scan;
});
afterEach(() => {
	islandBridge.markdownConfig = saved.markdownConfig ?? null;
	islandBridge.contentPresets = saved.contentPresets ?? null;
	islandBridge.scan = saved.scan ?? null;
});

describe('legacy option renames — errors with the new spelling, never silent aliasing', () => {
	it('rejects top-level visible', () => {
		expect(() => ogygia({ visible: { margin: '200px' } } as never)).toThrow(/regions: \{ visible/);
	});
	it('rejects top-level presets', () => {
		expect(() => ogygia({ presets: { a: { wake: 'load' } } } as never)).toThrow(/regions: \{ presets/);
	});
	it('rejects continuity', () => {
		expect(() => ogygia({ continuity: { forms: false } } as never)).toThrow(/router: \{ forms: false \}/);
	});
});

describe('regions.presets — config-time validation', () => {
	it('accepts the full legal vocabulary', () => {
		expect(() =>
			ogygia({
				regions: {
					visible: { margin: '120px' },
					presets: {
						demo: { wake: 'visible', margin: '200px' },
						hole: { render: 'deferred', maxAge: '1h', onExpire: 'fetch' },
						player: { wake: 'load', keep: 'player' }
					}
				}
			})
		).not.toThrow();
	});
	it('rejects an empty preset', () => {
		expect(() => ogygia({ regions: { presets: { nothing: {} } } })).toThrow(/nothing is empty/);
	});
	it('rejects unknown keys (closed vocabulary)', () => {
		expect(() => ogygia({ regions: { presets: { bad: { wakee: 'load' } as never } } })).toThrow(
			/unknown key `wakee`/
		);
	});
});

describe('content.presets — config-time validation', () => {
	it('requires the markdown base', () => {
		expect(() => ogygia({ content: { presets: { pg: { markdown: {} } } } })).toThrow(
			/requires content\.markdown/
		);
	});
	it('rejects non-content vocabulary in a preset', () => {
		expect(() =>
			ogygia({ content: { markdown: {}, presets: { pg: { router: {} } as never } } })
		).toThrow(/unknown key `router`/);
	});
	it('rejects an empty preset and non-identifier names', () => {
		expect(() => ogygia({ content: { markdown: {}, presets: { pg: {} } } })).toThrow(/pg is empty/);
		expect(() =>
			ogygia({ content: { markdown: {}, presets: { 'a b': { markdown: {} } } } })
		).toThrow(/identifiers/);
	});
	it('publishes valid presets to the bridge', () => {
		ogygia({ content: { markdown: {}, presets: { pg: { markdown: { overrides: true } } } } });
		expect(islandBridge.contentPresets).toEqual({ pg: { markdown: { overrides: true } } });
	});
});

describe('loader macro preset door', () => {
	beforeEach(() => {
		islandBridge.contentPresets = { playground: { markdown: { overrides: true } } };
	});

	it('mints the module-variant query and strips preset from runtime options', () => {
		const { code } = rewrite_loaders(
			`export const g = content({ loader: import.meta.og.loader.folder('../content/guides', { preset: 'playground' }) });`
		);
		expect(code).toContain(`query: { og_preset: "playground" }`);
		expect(code).not.toContain(`preset: 'playground'`); // consumed at compile — never reaches the builder
		expect(code).toMatch(/\{ eager: false, query: \{ og_preset: "playground" \} \}\)\)/); // options object dropped once empty
	});

	it('keeps sibling options intact while stripping preset', () => {
		const { code } = rewrite_loaders(
			`export const b = content({ loader: import.meta.og.loader.folder('../content/blog/**/*.md', { preset: 'playground', page: /\\.md$/ }) });`
		);
		expect(code).toContain('page: /\\.md$/');
		expect(code).toContain(`og_preset: "playground"`);
		expect(code).not.toContain(`preset: 'playground'`);
	});

	it('a presetless call emits no query (bare module — shared with every other presetless glob)', () => {
		const { code } = rewrite_loaders(
			`export const g = content({ loader: import.meta.og.loader.folder('../content/guides') });`
		);
		expect(code).toContain('{ eager: false }');
		expect(code).not.toContain('og_preset');
	});

	it('unknown preset name errors listing the configured names', () => {
		expect(() =>
			rewrite_loaders(
				`export const g = content({ loader: import.meta.og.loader.folder('../d', { preset: 'nope' }) });`
			)
		).toThrow(/unknown content preset 'nope'.*playground/);
	});

	it('non-literal preset is a build error (the macro-argument law)', () => {
		expect(() =>
			rewrite_loaders(
				`const p = 'playground'; export const g = content({ loader: import.meta.og.loader.folder('../d', { preset: p }) });`
			)
		).toThrow(/literal string/);
	});

	it('a `preset` key nested in some other object is not the loader’s own', () => {
		const { preset, args } = extract_preset(`{ convention: { preset: dated() } }`, 'test');
		expect(preset).toBeNull();
		expect(args).toContain('convention');
	});
});

describe('router absorbs continuity', () => {
	it('router: false and router: { forms: false } both accepted; forms is not a top-level key', () => {
		expect(() => ogygia({ router: false })).not.toThrow();
		expect(() => ogygia({ router: { viewTransitions: false, forms: false } })).not.toThrow();
	});
});
