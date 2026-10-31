/**
 * The content half of the v3 config surface (internal/notes/config.md): `content({ markdown, presets })`
 * validates presets at config time and publishes them to the bridge, and the loader macro's `preset`
 * door (literal-only, name-checked, stripped from runtime options, minted as a `?og_preset=`
 * module-variant query).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { content } from '../src/vite/index.js';
import { rewrite_loaders, extract_preset } from '../src/macros/loaders.js';
import { bridge } from '../src/bridge.js';

const saved: Partial<typeof bridge> = {};
beforeEach(() => {
	saved.markdownConfig = bridge.markdownConfig;
	saved.contentPresets = bridge.contentPresets;
	saved.scan = bridge.scan;
});
afterEach(() => {
	bridge.markdownConfig = saved.markdownConfig ?? null;
	bridge.contentPresets = saved.contentPresets ?? null;
	bridge.scan = saved.scan ?? null;
});

describe('content presets — config-time validation', () => {
	it('requires the markdown base', () => {
		expect(() => content({ presets: { pg: { markdown: {} } } })).toThrow(/requires `markdown`/);
	});
	it('rejects non-content vocabulary in a preset', () => {
		expect(() => content({ markdown: {}, presets: { pg: { router: {} } as never } })).toThrow(
			/unknown key `router`/
		);
	});
	it('rejects an empty preset and non-identifier names', () => {
		expect(() => content({ markdown: {}, presets: { pg: {} } })).toThrow(/pg is empty/);
		expect(() => content({ markdown: {}, presets: { 'a b': { markdown: {} } } })).toThrow(
			/identifiers/
		);
	});
	it('publishes valid presets to the bridge', () => {
		content({ markdown: {}, presets: { pg: { markdown: { overrides: true } } } });
		expect(bridge.contentPresets).toEqual({ pg: { markdown: { overrides: true } } });
	});
});

describe('loader macro preset door', () => {
	beforeEach(() => {
		bridge.contentPresets = { playground: { markdown: { overrides: true } } };
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
