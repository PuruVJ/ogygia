import { describe, it, expect } from 'vitest';
import { nearest_attr } from '../../src/runtime/nearest-attr.js';

describe('nearest_attr (the islandKey lookup)', () => {
	it('takes the nearest keyed ancestor, across shadow roots', () => {
		const outer = document.createElement('div');
		outer.setAttribute('data-block-id', 'outer');
		const inner = document.createElement('div');
		inner.setAttribute('data-block-id', 'inner');
		const host = document.createElement('x-widget');
		outer.append(inner);
		inner.append(host);
		const shadow = host.attachShadow({ mode: 'open' });
		const island = document.createElement('ogygia-region');
		shadow.append(island);
		document.body.append(outer);
		// inside the component's shadow tree: the block around the component, the nearest one
		expect(nearest_attr(island, 'data-block-id')).toBe('inner');
		// an island carrying the attribute itself is its own key
		island.setAttribute('data-block-id', 'self');
		expect(nearest_attr(island, 'data-block-id')).toBe('self');
		expect(nearest_attr(island, 'data-missing')).toBe(null);
		outer.remove();
	});
});
