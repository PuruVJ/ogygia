import { describe, expect, it } from 'vitest';
import { server_sourcemaps_plugin } from '../src/vite/server-sourcemaps.js';

// With the profiler on, the server build writes hidden sourcemaps; the client build never does.

type Handler = (
	config: { build?: { ssr?: boolean; sourcemap?: unknown } },
	env: { command: string }
) => unknown;
const handler = (on: boolean) =>
	(server_sourcemaps_plugin(on).config as unknown as { handler: Handler }).handler;
const reset = () =>
	delete (globalThis as Record<symbol, unknown>)[Symbol.for('ogygia.server-hidden-maps')];

describe('server_sourcemaps_plugin', () => {
	it('the server build gets hidden maps; the client build Kit starts after it gets them back off', () => {
		reset();
		expect(handler(true)({ build: { ssr: true } }, { command: 'build' })).toEqual({
			build: { sourcemap: 'hidden' }
		});
		// Kit copies the server's setting into the client build (a fresh plugin instance)
		expect(
			handler(true)({ build: { ssr: false, sourcemap: 'hidden' } }, { command: 'build' })
		).toEqual({ build: { sourcemap: false } });
	});

	it("two apps built in one process: one app's hidden maps do not turn off the other's", () => {
		reset();
		const ssr = { build: { ssr: true } };
		// app A: the profiler turned them on; app B chose 'hidden' itself
		handler(true)({ root: '/a', ...ssr } as never, { command: 'build' });
		handler(true)({ root: '/b', build: { ssr: true, sourcemap: 'hidden' } } as never, {
			command: 'build'
		});
		expect(
			handler(true)({ root: '/b', build: { ssr: false, sourcemap: 'hidden' } } as never, {
				command: 'build'
			})
		).toBeUndefined();
		expect(
			handler(true)({ root: '/a', build: { ssr: false, sourcemap: 'hidden' } } as never, {
				command: 'build'
			})
		).toEqual({ build: { sourcemap: false } });
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
