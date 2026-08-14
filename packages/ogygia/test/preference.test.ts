import { describe, expect, it, beforeEach, vi } from 'vitest';
import { preference, preference_switch } from '../src/preference.js';

describe('preference()', () => {
	it('rejects a default that is not one of the values', () => {
		expect(() => preference({ name: 'x', values: ['a', 'b'], default: 'c' })).toThrow(/default 'c' is not one of values/);
	});

	it('exposes name/values/default/attr', () => {
		const p = preference({ name: 'code-language', values: ['ts', 'js'], default: 'ts' });
		expect(p.attr).toBe('data-pref-code-language');
		expect(p.values).toEqual(['ts', 'js']);
		expect(p.default).toBe('ts');
	});

	it('head() is a self-contained no-flash script referencing localStorage + the attr', () => {
		const p = preference({ name: 'code-language', values: ['ts', 'js'], default: 'ts' });
		const html = p.head();
		expect(html.startsWith('<script>')).toBe(true);
		expect(html).toContain('localStorage.getItem');
		expect(html).toContain('data-pref-');
		// the spec is passed as JSON args, not closed over
		expect(html).toContain('"code-language"');
		expect(html).toContain('["ts","js"]');
	});

	describe('client get/set (jsdom-ish document + localStorage stubs)', () => {
		const store = new Map<string, string>();
		beforeEach(() => {
			store.clear();
			const attrs = new Map<string, string>();
			vi.stubGlobal('localStorage', {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v)
			});
			vi.stubGlobal('document', {
				documentElement: {
					getAttribute: (a: string) => attrs.get(a) ?? null,
					setAttribute: (a: string, v: string) => void attrs.set(a, v)
				}
			});
		});

		it('set persists to localStorage + applies the attr; get reads it back; invalid → default', () => {
			const p = preference({ name: 'pm', values: ['npm', 'pnpm', 'yarn'], default: 'npm' });
			expect(p.get()).toBe('npm'); // attr unset → default
			p.set('pnpm');
			expect(store.get('og-pref-pm')).toBe('pnpm');
			expect(p.get()).toBe('pnpm');
			p.set('bun'); // not a value → coerced to default
			expect(p.get()).toBe('npm');
		});
	});

	it('get() returns the default on the server (no document)', () => {
		const p = preference({ name: 'theme', values: ['light', 'dark'], default: 'light' });
		expect(p.get()).toBe('light');
	});

	it('preference_switch() is a self-contained delegated <script> wiring [data-pref][data-pref-set]', () => {
		const html = preference_switch();
		expect(html.startsWith('<script>')).toBe(true);
		expect(html).toContain('addEventListener');
		expect(html).toContain('[data-pref][data-pref-set]'); // the delegation selector
		expect(html).toMatch(/setAttribute\(["']data-pref-["']/); // quote-agnostic (esbuild may normalize)
		expect(html).toContain('localStorage.setItem');
	});
});
