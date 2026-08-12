import { describe, expect, it } from 'vitest';
import {
	KEEP_ATTR,
	collect_persist_pairs,
	index_top_level_persist
} from '../src/runtime/persist.js';

/** Minimal tree for persist indexing (no real DOM). */
class FakeEl {
	children: FakeEl[] = [];
	parent: FakeEl | null = null;
	constructor(readonly attrs: Record<string, string> = {}) {}

	append(...kids: FakeEl[]) {
		for (const k of kids) {
			k.parent = this;
			this.children.push(k);
		}
		return this;
	}

	getAttribute(name: string) {
		return this.attrs[name] ?? null;
	}

	get parentElement() {
		return this.parent;
	}

	closest(sel: string) {
		if (sel !== `[${KEEP_ATTR}]`) return null;
		let p: FakeEl | null = this;
		while (p) {
			if (p.attrs[KEEP_ATTR] != null) return p;
			p = p.parent;
		}
		return null;
	}
}

function root(children: FakeEl[]) {
	const r = new FakeEl();
	r.append(...children);
	return {
		querySelectorAll(_sel: string) {
			const out: FakeEl[] = [];
			const walk = (el: FakeEl) => {
				if (el.attrs[KEEP_ATTR] != null) out.push(el);
				for (const c of el.children) walk(c);
			};
			for (const c of r.children) walk(c);
			return out;
		}
	} as unknown as ParentNode;
}

describe('data-ogygia-keep indexing', () => {
	it('indexes top-level keys', () => {
		const nav = new FakeEl({ [KEEP_ATTR]: 'nav' });
		const foot = new FakeEl({ [KEEP_ATTR]: 'foot' });
		const map = index_top_level_persist(root([nav, foot]));
		expect(map.get('nav')).toBe(nav);
		expect(map.get('foot')).toBe(foot);
		expect(map.size).toBe(2);
	});

	it('skips nested persist ancestors', () => {
		const inner = new FakeEl({ [KEEP_ATTR]: 'inner' });
		const outer = new FakeEl({ [KEEP_ATTR]: 'outer' }).append(inner);
		const map = index_top_level_persist(root([outer]));
		expect(map.get('outer')).toBe(outer);
		expect(map.has('inner')).toBe(false);
	});

	it('first duplicate key wins', () => {
		const a = new FakeEl({ [KEEP_ATTR]: 'nav' });
		const b = new FakeEl({ [KEEP_ATTR]: 'nav' });
		const map = index_top_level_persist(root([a, b]));
		expect(map.get('nav')).toBe(a);
		expect(map.size).toBe(1);
	});

	it('ignores empty keys', () => {
		const map = index_top_level_persist(root([new FakeEl({ [KEEP_ATTR]: '  ' })]));
		expect(map.size).toBe(0);
	});

	it('pairs only keys present on both sides', () => {
		const live_nav = new FakeEl({ [KEEP_ATTR]: 'nav' });
		const live_only = new FakeEl({ [KEEP_ATTR]: 'only-old' });
		const next_nav = new FakeEl({ [KEEP_ATTR]: 'nav' });
		const next_only = new FakeEl({ [KEEP_ATTR]: 'only-new' });
		const pairs = collect_persist_pairs(root([live_nav, live_only]), root([next_nav, next_only]));
		expect(pairs).toEqual([{ live: live_nav, next: next_nav }]);
	});
});
