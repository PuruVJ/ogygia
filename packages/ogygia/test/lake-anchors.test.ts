// Unit tests for lake lift delimiter relocation (no DOM / Playwright).
import { describe, test, expect } from 'vitest';
import {
	relocate_trailing_empty_comments,
	type NodeLike,
	type FragmentLike,
	type ParentLike
} from '../src/runtime/lake-anchors.js';

function comment(data: string): NodeLike {
	return { nodeType: 8, data };
}

function makeFrag(nodes: NodeLike[]): FragmentLike & { nodes: NodeLike[] } {
	const nodes_mut = [...nodes];
	return {
		nodes: nodes_mut,
		get lastChild() {
			return nodes_mut[nodes_mut.length - 1] ?? null;
		},
		removeChild(node: NodeLike) {
			const i = nodes_mut.lastIndexOf(node);
			if (i >= 0) nodes_mut.splice(i, 1);
		}
	};
}

describe('relocate_trailing_empty_comments', () => {
	test('moves trailing empty comments from partial into lake (contentful lake = 3)', () => {
		const content = comment('keep');
		const d1 = comment('');
		const d2 = comment('');
		const d3 = comment('');
		const frag = makeFrag([content, d1, d2, d3]);
		const kids: NodeLike[] = [];
		const lake: ParentLike = {
			appendChild(node) {
				kids.push(node);
			}
		};
		expect(relocate_trailing_empty_comments(frag, lake)).toBe(3);
		expect(frag.nodes).toEqual([content]);
		expect(kids).toEqual([d1, d2, d3]);
	});

	test('preserves order of delimiters', () => {
		// Distinct data would not relocate — use object identity via order of empties only.
		const a = comment('');
		const b = comment('');
		const c = comment('');
		const frag = makeFrag([comment('x'), a, b, c]);
		const kids: NodeLike[] = [];
		const lake: ParentLike = { appendChild: (n) => kids.push(n) };
		relocate_trailing_empty_comments(frag, lake);
		expect(kids).toEqual([a, b, c]);
	});

	test('leaves non-empty trailing comments on the partial', () => {
		const keep = comment('[');
		const frag = makeFrag([keep]);
		const kids: NodeLike[] = [];
		const lake: ParentLike = { appendChild: (n) => kids.push(n) };
		expect(relocate_trailing_empty_comments(frag, lake)).toBe(0);
		expect(frag.nodes).toEqual([keep]);
		expect(kids).toEqual([]);
	});

	test('no-op on empty partial', () => {
		const frag = makeFrag([]);
		const kids: NodeLike[] = [];
		const lake: ParentLike = { appendChild: (n) => kids.push(n) };
		expect(relocate_trailing_empty_comments(frag, lake)).toBe(0);
		expect(kids).toEqual([]);
	});

	test('stops at first non-empty-comment from the end', () => {
		const leading = comment('');
		const mid = { nodeType: 1 } as NodeLike; // element-ish
		const frag = makeFrag([leading, mid, comment(''), comment('')]);
		const kids: NodeLike[] = [];
		const lake: ParentLike = { appendChild: (n) => kids.push(n) };
		expect(relocate_trailing_empty_comments(frag, lake)).toBe(2);
		expect(frag.nodes).toEqual([leading, mid]);
		expect(kids).toHaveLength(2);
		expect(kids.every((k) => k.data === '')).toBe(true);
	});
});
