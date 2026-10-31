/**
 * The config surface: the root is the region system (`visible`, `presets`, `ttl`, `maxPageAge`)
 * beside the router and the plugins.
 *
 * Covers: the legacy rename map (errors, never aliasing), the region options' config-time
 * validation, and the router. Content presets and the loader macro's `preset` door live with the
 * content plugin (packages/content/test/config-surface.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { ogygia } from '../src/vite/index.ts';
import { resolve_options } from '../src/vite/options.ts';
import { region_ttl_module } from '../src/compiler/link/caps.ts';

describe('legacy option renames — errors with the new spelling, never silent aliasing', () => {
	it('rejects regions (its keys moved to the root)', () => {
		expect(() => ogygia({ regions: { visible: { margin: '200px' } } } as never)).toThrow(
			/write `visible`, `presets`, `ttl` and `maxPageAge` directly/
		);
	});
	it('rejects continuity', () => {
		expect(() => ogygia({ continuity: { forms: false } } as never)).toThrow(
			/router: \{ forms: false \}/
		);
	});
	it('rejects regionTtl (now ttl)', () => {
		expect(() => ogygia({ regionTtl: 600 } as never)).toThrow(/ogygia\(\{ ttl/);
	});
	it('rejects content (now the @ogygia/content plugin)', () => {
		expect(() => ogygia({ content: { markdown: {} } } as never)).toThrow(
			/list `content\(\{ markdown, presets \}\)`.*beside `ogygia\(\)`/
		);
	});
	it('rejects devtools and profiler (now the @ogygia/devtools plugin)', () => {
		expect(() => ogygia({ devtools: true } as never)).toThrow(
			/list `devtools\(\)`.*beside `ogygia\(\)`/
		);
		expect(() => ogygia({ profiler: true } as never)).toThrow(/devtools\(\{ profiler/);
	});
	it('rejects plugins (they are Vite plugins listed beside ogygia())', () => {
		expect(() => ogygia({ plugins: [] } as never)).toThrow(
			/plugins: \[ogygia\(\), flags\(\), sveltekit\(\)\]/
		);
	});
});

describe('ttl — the capability lifetime', () => {
	it('is read from ttl and clamped to [60, 86400]', () => {
		const ttl = (v?: number) => resolve_options({ ttl: v }, 3600).region_ttl;
		expect(ttl()).toBe(3600);
		expect(ttl(600)).toBe(600);
		expect(ttl(5)).toBe(60);
		expect(ttl(10 * 86400)).toBe(86400);
	});
});

describe('maxPageAge — the oldest cached page whose holes still come back', () => {
	const renew = (maxPageAge?: number) => resolve_options({ maxPageAge }, 3600, 691200).renew_window;
	it('defaults to 8 days', () => {
		expect(renew()).toBe(691200);
	});
	it('takes the app’s own number (a CDN that keeps pages longer)', () => {
		expect(renew(30 * 24 * 3600)).toBe(2592000);
		expect(renew(0)).toBe(0);
	});
	it('is capped at the prerender capability life (10 years)', () => {
		expect(renew(1e12)).toBe(10 * 365 * 24 * 3600);
	});
	it('rejects anything but seconds ≥ 0', () => {
		for (const bad of [-1, Number.NaN, Infinity, '30d' as never])
			expect(() => resolve_options({ maxPageAge: bad }, 3600)).toThrow(/maxPageAge must be/);
	});
	it('never touches the hole URL life (ttl)', () => {
		expect(resolve_options({ maxPageAge: 30 * 24 * 3600 }, 3600).region_ttl).toBe(3600);
	});
	it('reaches the server (and never the browser) through virtual:ogygia/region-ttl', () => {
		expect(region_ttl_module(true, 3600, 2592000)).toContain('export const renewWindow = 2592000;');
		expect(region_ttl_module(false, 3600, 2592000)).toContain('export const renewWindow = 0;');
	});
});

describe('presets — config-time validation', () => {
	it('accepts the full legal vocabulary', () => {
		expect(() =>
			ogygia({
				visible: { margin: '120px' },
				presets: {
					demo: { wake: 'visible', margin: '200px' },
					hole: { render: 'deferred', maxAge: '1h', onExpire: 'fetch' },
					player: { wake: 'load', keep: 'player' }
				}
			})
		).not.toThrow();
	});
	it("takes `fetch`, a deferred hole's timing (0.10.0 rejected it: no deferred preset could be written)", () => {
		expect(() =>
			ogygia({
				presets: {
					megamenu: { render: 'deferred', fetch: 'interaction', prefetch: 'idle' },
					countrySelector: { render: 'deferred', fetch: 'idle', maxAge: '1h' }
				}
			})
		).not.toThrow();
	});
	it('rejects an empty preset', () => {
		expect(() => ogygia({ presets: { nothing: {} } })).toThrow(/nothing is empty/);
	});
	it('rejects unknown keys (closed vocabulary)', () => {
		expect(() => ogygia({ presets: { bad: { wakee: 'load' } as never } })).toThrow(
			/unknown key `wakee`/
		);
	});
});

describe('router absorbs continuity', () => {
	it('router: false and router: { forms: false } both accepted; forms is not a top-level key', () => {
		expect(() => ogygia({ router: false })).not.toThrow();
		expect(() => ogygia({ router: { viewTransitions: false, forms: false } })).not.toThrow();
	});
});
