import { describe, it, expect } from 'vitest';
import { mpaSpeculationRules } from '../src/compiler/link/speculation.js';

// ─────────────────────────────────────────────────────────────────────────────
// MPA-mode Speculation Rules (`router: false` → the handle injects these; SPA mode emits none —
// speculation caches serve real navigations only, which a body-swap router can never read).
// ─────────────────────────────────────────────────────────────────────────────

describe('mpaSpeculationRules', () => {
	const rules = JSON.parse(mpaSpeculationRules());

	it('ships BOTH lists — prerender (Chromium) and prefetch (Firefox), same where-clause', () => {
		expect(rules.prerender).toHaveLength(1);
		expect(rules.prefetch).toHaveLength(1);
		expect(rules.prerender[0].where).toEqual(rules.prefetch[0].where);
		expect(rules.prerender[0].eagerness).toBe('moderate');
		expect(rules.prefetch[0].eagerness).toBe('moderate');
	});

	it('covers same-origin links, never the region endpoint', () => {
		const s = JSON.stringify(rules);
		expect(s).toContain('"href_matches":"/*"');
		expect(s).toContain('__ogygia__'); // the endpoint exclusion
		expect(s).toContain('nofollow');
	});

	it('honors the per-link opt-out cascade (off disables, on re-enables inside off)', () => {
		const cascade = rules.prerender[0].where.and.find((c: Record<string, unknown>) => 'or' in c);
		const [not_off, on] = cascade.or;
		expect(not_off.not.selector_matches).toContain('data-ogygia-speculate="off"');
		expect(on.selector_matches).toContain('data-ogygia-speculate="on"');
	});

	it('is valid JSON with no functions/undefined (a literal script body)', () => {
		expect(() => JSON.parse(mpaSpeculationRules())).not.toThrow();
	});
});
