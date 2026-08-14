import { describe, expect, it } from 'vitest';
import { dated, date_of } from '../src/content/convention.js';

describe('date_of', () => {
	it('reads a valid date prefix', () => {
		expect(date_of('2026-08-13-sveltekit-3-release-candidate')).toBe('2026-08-13');
	});
	it('rejects undated and impossible-date segments', () => {
		expect(date_of('about')).toBeNull();
		expect(date_of('2026-13-01-nope')).toBeNull();
		expect(date_of('2026-00-10-nope')).toBeNull();
		expect(date_of('2026-02-40-nope')).toBeNull();
	});
});

describe('dated()', () => {
	const c = dated();

	it('strips the date from the slug and orders chronologically', () => {
		const a = c.segment('2016-11-26-frameworks-without-the-framework');
		const b = c.segment('2026-08-13-sveltekit-3-release-candidate');
		expect(a.slug).toBe('frameworks-without-the-framework');
		expect(b.slug).toBe('sveltekit-3-release-candidate');
		expect(a.order).toBeLessThan(b.order);
	});

	it('same-day posts share an order (ties break alphabetically downstream)', () => {
		const a = c.segment('2026-08-01-first');
		const b = c.segment('2026-08-01-second');
		expect(a.order).toBe(b.order);
	});

	it('undated segments pass through unordered', () => {
		const s = c.segment('authors');
		expect(s).toEqual({ slug: 'authors', order: Number.MAX_SAFE_INTEGER });
	});

	it('verify flags only impossible date-looking prefixes', () => {
		expect(c.verify('', ['2026-08-13-fine', 'about'], undefined)).toEqual([]);
		const issues = c.verify('', ['2026-99-99-bad'], undefined);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toContain('impossible date');
	});

	it('honors ordered:false opt-out', () => {
		expect(c.verify('x', ['2026-99-99-bad'], { ordered: false })).toEqual([]);
	});
});

describe('dated({ format })', () => {
	it('YYYYMMDD compact format', () => {
		const c = dated({ format: 'YYYYMMDD' });
		expect(c.segment('20260813-release')).toEqual({
			slug: 'release',
			order: Math.floor(Date.UTC(2026, 7, 13) / 86_400_000)
		});
		expect(date_of('20260813-release', 'YYYYMMDD')).toBe('2026-08-13');
	});

	it('DD-MM-YYYY european format', () => {
		const c = dated({ format: 'DD-MM-YYYY' });
		expect(c.segment('13-08-2026-release').slug).toBe('release');
		expect(date_of('13-08-2026-release', 'DD-MM-YYYY')).toBe('2026-08-13');
	});

	it('dotted separators are literal', () => {
		expect(date_of('2026.08.13-release', 'YYYY.MM.DD')).toBe('2026-08-13');
		expect(date_of('2026x08y13-release', 'YYYY.MM.DD')).toBeNull();
	});

	it('throws on a format missing a token', () => {
		expect(() => dated({ format: 'YYYY-MM' })).toThrow('must contain YYYY, MM and DD');
	});
});
