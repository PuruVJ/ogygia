import { describe, expect, it } from 'vitest';
import {
	mark_region_changed,
	region_changed,
	unwatch_region,
	watch_region
} from '../../src/runtime/drift-watch.js';

function region(html: string): HTMLElement {
	const el = document.createElement('ogygia-region');
	el.innerHTML = html;
	document.body.append(el);
	return el;
}

describe('drift-watch: which sleeping islands were touched', () => {
	it('an untouched island is not changed; attribute edits do not count', () => {
		const r = region('<p>hi</p>');
		watch_region();
		r.querySelector('p')!.setAttribute('class', 'x');
		expect(region_changed(r)).toBe(false);
		unwatch_region();
		r.remove();
	});

	it('a node or text change inside marks it, and its enclosing island too', () => {
		const outer = region('<div><ogygia-region><p>a</p></ogygia-region></div>');
		const inner = outer.querySelector('ogygia-region')!;
		const other = region('<p>b</p>');
		watch_region();
		inner.querySelector('p')!.firstChild!.nodeValue = 'changed';
		expect(region_changed(inner)).toBe(true);
		expect(region_changed(outer)).toBe(true);
		expect(region_changed(other)).toBe(false);
		unwatch_region();
		outer.remove();
		other.remove();
	});

	it('records pending at the last unwatch still count', () => {
		const r = region('<p>c</p>');
		watch_region();
		r.append(document.createElement('span'));
		unwatch_region();
		expect(region_changed(r)).toBe(true);
		r.remove();
	});

	it('mark_region_changed forces the comparison', () => {
		const r = region('<p>d</p>');
		mark_region_changed(r);
		expect(region_changed(r)).toBe(true);
		r.remove();
	});
});
