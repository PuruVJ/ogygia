import { describe, expect, it } from 'vitest';
import { rewrite_wire, WIRE_EXPR } from '../src/compiler/macros/wire.js';
import {
	wire,
	__register_transportable,
	reduce_transportable,
	revive_transportable
} from '../src/live-transport.js';
import { moduleHasTransportable } from '../src/compiler/content/transportables.js';

const MARKUP = ['.svelte'] as const;
const CODEC = `{ encode: (c) => c.v, decode: (v) => new C(v) }`;

describe('rewrite_wire — the strict compile construct', () => {
	it('consumes the member and mints the symbol key', () => {
		const src = `export class C {\n\tstatic wire = import.meta.og.wire(${CODEC});\n}`;
		const out = rewrite_wire(src, '/app/src/lib/c.svelte.ts', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC};`);
		expect(out).not.toContain('import.meta.og.wire');
		expect(out).not.toContain('static wire =');
	});

	it('rewrites inside a .svelte <script module> block only — markup prose is untouched', () => {
		const src = [
			`<script module lang="ts">`,
			`\texport class C { static wire = import.meta.og.wire(${CODEC}); }`,
			`</script>`,
			`<p>the marker import.meta.og.wire() in prose stays literal</p>`
		].join('\n');
		const out = rewrite_wire(src, '/app/src/lib/C.svelte', MARKUP);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC};`);
		expect(out).toContain('<p>the marker import.meta.og.wire() in prose stays literal</p>');
	});

	it('AST path: a marker in a comment or string is NOT rewritten (and not judged as misuse)', () => {
		const src = [
			`// docs mention import.meta.og.wire() here`,
			`const s = "import.meta.og.wire()";`,
			`export class C { static wire = import.meta.og.wire(${CODEC}); }`
		].join('\n');
		const out = rewrite_wire(src, '/app/x.ts', MARKUP);
		expect(out).toContain(`// docs mention import.meta.og.wire() here`);
		expect(out).toContain(`const s = "import.meta.og.wire()";`);
		expect(out).toContain(`static [${WIRE_EXPR}] = ${CODEC};`);
	});

	it('a codec containing parens/strings/regex survives verbatim', () => {
		const codec = `{ encode: (c) => c.v.replace(/x)/, ')'), decode: (v) => new C(v) }`;
		const src = `class C { static wire = import.meta.og.wire(${codec}); }`;
		expect(rewrite_wire(src, '/app/c.ts', MARKUP)).toContain(`static [${WIRE_EXPR}] = ${codec}`);
	});

	it('scanner fallback (unparseable source) still rewrites the legal member', () => {
		const src = [
			`class C { static wire = import.meta.og.wire(${CODEC}); }`,
			`const broken = (`
		].join('\n');
		expect(rewrite_wire(src, '/app/x.ts', MARKUP)).toContain(`static [${WIRE_EXPR}] = ${CODEC};`);
	});

	it('returns the same reference when there is nothing to do', () => {
		const src = `export const x = 1;`;
		expect(rewrite_wire(src, '/app/x.ts', MARKUP)).toBe(src);
	});
});

describe('rewrite_wire — strictness (build errors, file:line)', () => {
	it('rejects a bare value use', () => {
		expect(() => rewrite_wire(`const K = import.meta.og.wire;`, '/app/x.ts', MARKUP)).toThrow(
			/x\.ts:1 — bare import\.meta\.og\.wire used as a value/
		);
	});

	it('rejects a call outside a static class member', () => {
		expect(() =>
			rewrite_wire(`const c = import.meta.og.wire(${CODEC});`, '/app/x.ts', MARKUP)
		).toThrow(/called outside a static class member/);
	});

	it('rejects a wrongly-named static member', () => {
		const src = `class C { static codec = import.meta.og.wire(${CODEC}); }`;
		expect(() => rewrite_wire(src, '/app/x.ts', MARKUP)).toThrow(/must be named exactly `wire`/);
	});

	it('rejects an arg-less call (codec required)', () => {
		const src = `class C { static wire = import.meta.og.wire(); }`;
		expect(() => rewrite_wire(src, '/app/x.ts', MARKUP)).toThrow(/takes exactly one argument/);
	});

	it('reports the correct line for a deep misuse', () => {
		const src = `\n\n\nconst K = import.meta.og.wire;`;
		expect(() => rewrite_wire(src, '/app/x.ts', MARKUP)).toThrow(/x\.ts:4 —/);
	});
});

describe('prescan detection — raw source (pre-rewrite)', () => {
	it('a class with the blessed spelling is detected as transportable', () => {
		const src = `export class C { static wire = import.meta.og.wire(${CODEC}); }`;
		expect(moduleHasTransportable(src, '/app/c.ts')).toBe(true);
	});
	it('a REWRITTEN computed member is still detected', () => {
		const src = `export class C { static [Symbol.for('ogygia.wire')] = ${CODEC}; }`;
		expect(moduleHasTransportable(src, '/app/c.ts')).toBe(true);
	});
});

describe('runtime — explicit codec round-trip', () => {
	class Point {
		x = 0;
		y = 0;
		static [wire] = {
			encode: (p: Point) => ({ x: p.x, y: p.y }),
			decode: (d: { x: number; y: number }) => Object.assign(new Point(), d)
		};
		mag() {
			return Math.hypot(this.x, this.y);
		}
	}
	__register_transportable('test/point', Point);

	it('round-trips through encode/decode and rebuilds a REAL instance', () => {
		const p = new Point();
		p.x = 3;
		p.y = 4;
		const payload = reduce_transportable(p)!;
		expect(payload.t).toBe('test/point');
		expect(payload.d).toEqual({ x: 3, y: 4 });
		const back = revive_transportable(payload, false) as Point;
		expect(back).toBeInstanceOf(Point);
		expect(back.mag()).toBe(5);
	});

	it('one instance mints one wire id (identity memo)', () => {
		const p = new Point();
		expect(reduce_transportable(p)!.i).toBe(reduce_transportable(p)!.i);
	});
});
