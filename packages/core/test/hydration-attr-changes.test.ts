// A `changed` island is told apart: attributes only (the same elements and text — a web component
// setting its own as it upgrades, an empty inline style) or markup (text or elements differ). And a
// test can leave chosen attribute changes out.
import { describe, it, expect } from 'vitest';
import { attr_changes } from '../src/runtime/beacon.ts';
import { apply_attr_rules } from '../src/insights/attr-rules.ts';

describe('attr_changes', () => {
	it('each attribute a custom element set, added, removed or changed', () => {
		const ssr =
			'<div class="bar"><qds-icon-button aria-label="Country" icon="globe"></qds-icon-button> <a href="/x">Go</a></div>';
		const now =
			'<div class="bar"><qds-icon-button icon="globe" tabindex="0" aria-describedby="qds-tooltip-2"></qds-icon-button> <a href="/x" style="">Go</a></div>';
		expect(attr_changes(ssr, now)).toEqual([
			{ tag: 'qds-icon-button', name: 'aria-label', from: 'Country', to: null },
			{ tag: 'qds-icon-button', name: 'tabindex', from: null, to: '0' },
			{ tag: 'qds-icon-button', name: 'aria-describedby', from: null, to: 'qds-tooltip-2' },
			{ tag: 'a', name: 'style', from: null, to: '' }
		]);
	});
	it('a changed value', () => {
		expect(attr_changes('<img width="NaN" height="NaN">', '<img width="0" height="0">')).toEqual([
			{ tag: 'img', name: 'width', from: 'NaN', to: '0' },
			{ tag: 'img', name: 'height', from: 'NaN', to: '0' }
		]);
	});
	it('text or elements that differ are not attributes only', () => {
		expect(attr_changes('<p>12:00</p>', '<p>12:01</p>')).toBe(null);
		expect(attr_changes('<p>a</p>', '<p>a</p><p>b</p>')).toBe(null);
		expect(attr_changes('<p>a</p>', '<div>a</div>')).toBe(null);
		expect(attr_changes('<p class="a">x</p>', '<p class="b">y</p>')).toBe(null);
	});
	it('the same attributes in another order: attributes only, nothing to name', () => {
		expect(attr_changes('<a href="/x" class="c">x</a>', '<a class="c" href="/x">x</a>')).toEqual(
			[]
		);
	});
});

describe('apply_attr_rules', () => {
	const changes = [
		{ tag: 'qds-button', name: 'tabindex', from: null, to: '0' },
		{ tag: 'a', name: 'style', from: null, to: '' },
		{ tag: 'img', name: 'width', from: 'NaN', to: '0' }
	];
	it('by tag, name and new value; exact strings and patterns', () => {
		const { left, ignored } = apply_attr_rules(changes, [
			{ tag: { re: '^qds-' }, name: { re: '^(tabindex|aria-)' } },
			{ name: 'style', value: '' }
		]);
		expect(ignored.map((c) => c.name)).toEqual(['tabindex', 'style']);
		expect(left).toEqual([{ tag: 'img', name: 'width', from: 'NaN', to: '0' }]);
	});
	it('a removed attribute is matched by its old value', () => {
		const { ignored } = apply_attr_rules(
			[{ tag: 'x', name: 'aria-label', from: 'Country', to: null }],
			[{ name: 'aria-label', value: 'Country' }]
		);
		expect(ignored).toHaveLength(1);
	});
	it('no rules: nothing ignored', () => {
		expect(apply_attr_rules(changes, []).left).toBe(changes);
	});
});
