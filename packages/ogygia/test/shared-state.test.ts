// The SharedState MEMBRANE: only inert, devalue-representable data enters the page store —
// two builds' svelte runtimes must never see each other's live values. Reactive proxies
// degrade to snapshots; functions/class instances throw AT THE WRITE SITE.
import { describe, it, expect } from 'vitest';
import { SharedState } from '../src/shared-state.js';

describe('SharedState membrane (devalue snapshot-on-write)', () => {
	it('plain data round-trips, devalue vocabulary included', () => {
		const s = new SharedState('t.plain', { items: [] as string[] });
		s.current = { items: ['a'] };
		expect(s.current.items).toEqual(['a']);
		const rich = new SharedState<{ when: Date; tags: Set<string> }>('t.rich', {
			when: new Date(0),
			tags: new Set(['x'])
		});
		expect(rich.current.when).toBeInstanceOf(Date);
		expect(rich.current.tags.has('x')).toBe(true);
	});

	it('writes are SNAPSHOTS — later mutation of the source object does not leak in', () => {
		const s = new SharedState('t.snap', { items: [] as string[] });
		const src = { items: ['a'] };
		s.current = src;
		src.items.push('LEAK');
		expect(s.current.items).toEqual(['a']);
	});

	it('a proxy degrades to a plain snapshot (reactive wrappers never enter the store)', () => {
		const s = new SharedState('t.proxy', { n: 0 });
		let reads = 0;
		const proxied = new Proxy({ n: 7 }, { get: (t, p) => (reads++, Reflect.get(t, p)) });
		s.current = proxied as { n: number };
		expect(reads).toBeGreaterThan(0); // the snapshot read THROUGH it…
		expect(s.current.n).toBe(7); // …and stored only the plain value
	});

	it('functions and class instances THROW loudly at the write site', () => {
		const s = new SharedState('t.alive', {} as Record<string, unknown>);
		expect(() => {
			s.current = { onSave: () => {} };
		}).toThrow(/plain data.*do not cross build boundaries/s);
		class Cart {
			items: string[] = [];
		}
		expect(() => {
			s.current = { cart: new Cart() };
		}).toThrow(/plain data/);
	});

	it('the vanilla door enforces the same membrane', () => {
		new SharedState('t.vanilla', { ok: true }); // installs globalThis.ogygia.shared
		const g = globalThis as { ogygia?: { shared?: (n: string) => { set(v: unknown): void } } };
		const handle = g.ogygia!.shared!('t.vanilla');
		expect(() => handle.set({ cb: () => {} })).toThrow(/plain data/);
	});
});

describe('foreign island props membrane', () => {
	it('a wired ref in a foreign sidecar is rejected loudly, never revived cross-build', async () => {
		const { foreign_region_prop_revivers } = await import('../src/runtime/foreign-props.js');
		const revivers = foreign_region_prop_revivers();
		expect(() => revivers.OgygiaRef({} as never)).toThrow(/build boundary.*plain data/s);
	});
});
