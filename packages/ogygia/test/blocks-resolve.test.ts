import { describe, expect, it } from 'vitest';
import { resolve_block_tree } from '../src/content/blocks.js';
import { isRegion } from '../src/region.js';
import type { Component } from 'svelte';

// A `with { region: 'raw' }` SSR-leg binding, as the transform generates it.
function binding(id: string) {
	return {
		__ogRegion: id,
		__module: `/_app/immutable/og-region.${id}.js`,
		__component: (() => {}) as unknown as Component<Record<string, unknown>>,
		__sign: () => `./__ogygia__?id=${id}&sig=x`,
		__renderHtml: () => '<div>x</div>'
	};
}

describe('resolve_block_tree', () => {
	const registry = { Hero: binding('a1'), Grid: binding('b2'), Feature: binding('c3') };

	it('turns each node type into a region value', () => {
		const nodes = resolve_block_tree([{ type: 'Hero', props: { title: 'hi' } }], registry);
		expect(nodes).toHaveLength(1);
		expect(isRegion(nodes[0].of)).toBe(true);
		expect(nodes[0].of.props).toEqual({ title: 'hi' });
	});

	it('recurses into children', () => {
		const nodes = resolve_block_tree(
			[{ type: 'Grid', children: [{ type: 'Feature' }, { type: 'Feature' }] }],
			registry
		);
		expect(nodes[0].children).toHaveLength(2);
		expect(isRegion(nodes[0].children![0].of)).toBe(true);
	});

	it('skips an unregistered type rather than throwing', () => {
		const nodes = resolve_block_tree([{ type: 'Nope' }, { type: 'Hero' }], registry);
		expect(nodes).toHaveLength(1);
		expect((nodes[0].of as { id?: string }).id).toBe('a1');
	});

	it('carries no registry into the resolved tree (only region values)', () => {
		const nodes = resolve_block_tree([{ type: 'Hero' }], registry);
		const s = JSON.stringify(nodes, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
		expect(s).not.toContain('__sign');
		expect(s).not.toContain('__renderHtml');
	});

	it('accepts a single node or an array', () => {
		expect(resolve_block_tree({ type: 'Hero' }, registry)).toHaveLength(1);
		expect(resolve_block_tree([{ type: 'Hero' }, { type: 'Grid' }], registry)).toHaveLength(2);
		expect(resolve_block_tree(null, registry)).toHaveLength(0);
	});
});
