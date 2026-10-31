/**
 * The flags plugin: its manifest, its server realm's two hooks, and the facts a read reports.
 */
import { describe, it, expect } from 'vitest';
import { startPlugin } from '@ogygia/core/plugin/testing';
import { flags } from '../src/vite.ts';
import server from '../src/server.ts';
import { decide, flag } from '../src/index.ts';

const { app, ctx } = startPlugin(server, { name: '@ogygia/flags' });

describe('flags()', () => {
	it('is named by its package and names its server realm, the module beside it', () => {
		const plugin = flags();
		expect(plugin.name).toBe('@ogygia/flags');
		expect((plugin as unknown as Record<symbol, unknown>)[Symbol.for('ogygia.plugin')]).toEqual({
			name: '@ogygia/flags',
			server: new URL('../src/server.ts', import.meta.url).href
		});
	});
});

describe('the server realm', () => {
	it('primes the source in `request` and drains exposures in `done`', async () => {
		const sent: unknown[][] = [];
		const gate = flag('plugin-test-gate');
		decide({
			source: () => ({ 'plugin-test-gate': true }),
			exposure: (b) => void sent.push(b),
			batch: { max: 100, ms: 60_000 }
		});
		try {
			const request = new Request('http://x/');
			const c = ctx(request);
			await server.request!(c);
			expect(gate({ request, url: new URL(request.url) })).toBe(true);
			server.done!(c);
			expect(sent.flat().some((e) => (e as { name: string }).name === 'plugin-test-gate')).toBe(
				true
			);
		} finally {
			decide({ source: undefined, exposure: undefined });
		}
	});
});

describe('facts a read reports', () => {
	it('a read is a per-visitor read (a stored page never keeps one variant) and an assignment', () => {
		const hero = flag('plugin-test-hero', { a: 1, b: 1 });
		const request = new Request('http://x/');
		const variant = hero({ request, url: new URL('http://x/') });
		expect(app.facts(request).perVisitor).toBe('flag:plugin-test-hero');
		expect(app.facts(request).assignments).toEqual({ 'plugin-test-hero': variant });
	});
});
