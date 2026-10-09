import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { server_sourcemaps_plugin } from '../src/vite/server-sourcemaps.js';

// With the profiler on, the server build writes hidden sourcemaps; the client build writes them too
// and moves every one off its output (the profiler's server module keeps the app's: profiler-maps.ts).

type Handler = (
	config: { build?: { ssr?: boolean; sourcemap?: unknown } },
	env: { command: string }
) => unknown;
const handler = (on: boolean) =>
	(server_sourcemaps_plugin(on).config as unknown as { handler: Handler }).handler;
const reset = () =>
	delete (globalThis as Record<symbol, unknown>)[Symbol.for('ogygia.server-hidden-maps')];

describe('server_sourcemaps_plugin', () => {
	/** a client build instance given `config`, then its output written: which maps were left, which stashed */
	const client_write = (config: object) => {
		const p = server_sourcemaps_plugin(true);
		(p.config as unknown as { handler: Handler }).handler(config as never, { command: 'build' });
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cmaps-'));
		const client = path.join(out, 'output/client');
		fs.mkdirSync(path.join(client, '_app/immutable/chunks'), { recursive: true });
		for (const f of ['_app/immutable/a.js', '_app/immutable/chunks/b.js']) {
			fs.writeFileSync(path.join(client, f), '');
			fs.writeFileSync(path.join(client, f + '.map'), '{}');
		}
		const bundle = { '_app/immutable/a.js': {}, '_app/immutable/chunks/b.js': {} };
		(p.writeBundle as unknown as { handler: (o: { dir: string }, b: object) => void }).handler({ dir: client }, bundle);
		const left = ['_app/immutable/a.js.map', '_app/immutable/chunks/b.js.map'].filter((f) => fs.existsSync(path.join(client, f)));
		const stashed = ['_app/immutable/a.js.map', '_app/immutable/chunks/b.js.map'].filter((f) => fs.existsSync(path.join(out, 'ogygia-client-maps', f)));
		return { left, stashed };
	};

	it('the server build gets hidden maps; the client build Kit starts after it keeps them hidden and moves them off its output', () => {
		reset();
		expect(handler(true)({ build: { ssr: true } }, { command: 'build' })).toEqual({
			build: { sourcemap: 'hidden' }
		});
		// Kit copies the server's setting into the client build (a fresh plugin instance): the maps are
		// made (for the profiler's module) and none is left in the output to be served
		expect(handler(true)({ build: { ssr: false, sourcemap: 'hidden' } }, { command: 'build' })).toBeUndefined();
		expect(client_write({ build: { ssr: false, sourcemap: 'hidden' } })).toEqual({ left: [], stashed: ['_app/immutable/a.js.map', '_app/immutable/chunks/b.js.map'] });
	});

	it("two apps built in one process: one app's hidden maps are not taken from the other", () => {
		reset();
		const ssr = { build: { ssr: true } };
		// app A: the profiler turned them on; app B chose 'hidden' itself
		handler(true)({ root: '/a', ...ssr } as never, { command: 'build' });
		handler(true)({ root: '/b', build: { ssr: true, sourcemap: 'hidden' } } as never, {
			command: 'build'
		});
		// B's own maps stay where B's build wrote them; A's move off the output
		expect(client_write({ root: '/b', build: { ssr: false, sourcemap: 'hidden' } })).toEqual({ left: ['_app/immutable/a.js.map', '_app/immutable/chunks/b.js.map'], stashed: [] });
		expect(client_write({ root: '/a', build: { ssr: false, sourcemap: 'hidden' } }).left).toEqual([]);
	});

	it("the app's own choice wins; no profiler, no dev server: nothing", () => {
		reset();
		expect(
			handler(true)({ build: { ssr: true, sourcemap: false } }, { command: 'build' })
		).toBeUndefined();
		// maps the app asked for everywhere stay on the client too (this did not turn them on)
		expect(
			handler(true)({ build: { ssr: false, sourcemap: true } }, { command: 'build' })
		).toBeUndefined();
		expect(
			handler(true)({ build: { ssr: false, sourcemap: 'hidden' } }, { command: 'build' })
		).toBeUndefined();
		expect(handler(false)({ build: { ssr: true } }, { command: 'build' })).toBeUndefined();
		// a later build in the same process where the app chose 'hidden' itself: its client keeps it
		handler(true)({ build: { ssr: true } }, { command: 'build' });
		handler(true)({ build: { ssr: true, sourcemap: 'hidden' } }, { command: 'build' });
		expect(
			handler(true)({ build: { ssr: false, sourcemap: 'hidden' } }, { command: 'build' })
		).toBeUndefined();
		expect(handler(true)({ build: { ssr: true } }, { command: 'serve' })).toBeUndefined();
	});
});
