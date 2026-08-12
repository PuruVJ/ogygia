import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { region, isRegion, REGION_BRAND } from '../src/region.js';
import { ogygiaTransport } from '../src/transport.js';

const A = (() => {}) as unknown as Component<{ x: number }>;

describe('region()', () => {
	it('makes an inline partial from a plain component', () => {
		const f = region(A, { x: 1 });
		expect(isRegion(f)).toBe(true);
		expect(f.kind).toBe('inline');
		expect(f).toMatchObject({ kind: 'inline', component: A, props: { x: 1 } });
	});

	it('makes a DUAL partial from a marked binding (SSR leg): carries component + signer', () => {
		// What the transform rewrites `import X with { partial: 'load' }` to on the SSR leg.
		const binding = {
			__ogRegion: 'abc123',
			__module: '/@id/virtual:ogygia/island/abc123.js',
			__hydrate: 'load',
			__component: A,
			__sign: (id: string, props: Record<string, unknown>) =>
				`/🏝️?id=${id}&props=${JSON.stringify(props)}`
		} as unknown as Component<{ x: number }>;
		const f = region(binding, { x: 2 });
		expect(f.kind).toBe('dual');
		expect(f).toMatchObject({
			kind: 'dual',
			component: A,
			props: { x: 2 },
			id: 'abc123',
			module: '/@id/virtual:ogygia/island/abc123.js',
			hydrate: 'load'
		});
	});

	it('throws when a marked binding has no component/signer (client leg)', () => {
		const clientBinding = {
			__ogRegion: 'abc123',
			__module: '/@id/virtual:ogygia/island/abc123.js'
		} as unknown as Component<{ x: number }>;
		expect(() => region(clientBinding, { x: 1 })).toThrow(/turned into a region on the server/);
	});
});

describe('ogygiaTransport', () => {
	const sign = (id: string, props: Record<string, unknown>) =>
		`/🏝️?id=${id}&props=${JSON.stringify(props)}`;

	it('encodes a dual partial into a signed ticket (drops the component)', () => {
		const dual = region(
			{
				__ogRegion: 'abc123',
				__module: '/m.js',
				__hydrate: 'load',
				__component: A,
				__sign: sign
			} as unknown as Component<{ x: number }>,
			{ x: 2 }
		);
		const enc = ogygiaTransport.Region.encode(dual);
		expect(enc).not.toBe(false);
		// no component / no function survives
		expect(JSON.stringify(enc)).not.toContain('function');
		const back = ogygiaTransport.Region.decode(enc as never);
		expect(back).toMatchObject({
			kind: 'deferred',
			id: 'abc123',
			props: { x: 2 },
			url: '/🏝️?id=abc123&props={"x":2}',
			module: '/m.js',
			hydrate: 'load'
		});
		expect((back as Record<symbol, unknown>)[REGION_BRAND]).toBe(true);
	});

	it('refuses to encode an inline (unmarked) partial with a helpful error', () => {
		const inline = region(A, { x: 1 });
		expect(() => ogygiaTransport.Region.encode(inline)).toThrow(/region: 'raw'/);
	});

	it('ignores non-partial values', () => {
		expect(ogygiaTransport.Region.encode({ hello: 1 })).toBe(false);
		expect(ogygiaTransport.Region.encode(42)).toBe(false);
		expect(ogygiaTransport.Region.encode(null)).toBe(false);
	});
});
