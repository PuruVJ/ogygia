/**
 * The `handle` lifecycle hook: each plugin's wraps the rest of the request, first plugin outermost,
 * and a `transformPageChunk` it passes to `next()` sees the document after ogygia's own.
 */
import { describe, expect, it } from 'vitest';
import type { Handle } from '@sveltejs/kit';
import { around, type LivePlugin } from '../src/plugin/server.ts';
import type { ServerApp, ServerPlugin } from '../src/plugin/index.ts';

const live = (name: string, def: ServerPlugin<unknown, unknown>): LivePlugin => ({
	def,
	app: { name, options: { name } } as unknown as ServerApp<unknown>
});

describe('around()', () => {
	it('no handle hooks: the core itself', () => {
		const core: Handle = async () => new Response('core');
		expect(around([live('a', {})], core)).toBe(core);
	});

	it('nests first-plugin-outermost, and each sees its own options', async () => {
		const seen: string[] = [];
		const core: Handle = async () => {
			seen.push('core');
			return new Response('core');
		};
		const tag = (name: string): ServerPlugin<unknown, unknown> => ({
			async handle(ctx, next) {
				seen.push(`${name}:in:${(ctx.options as { name: string }).name}`);
				const res = await next();
				seen.push(`${name}:out`);
				return res;
			}
		});
		const handle = around([live('a', tag('a')), live('b', tag('b'))], core);
		await handle({ event: {} as never, resolve: async () => new Response('') });
		expect(seen).toEqual(['a:in:a', 'b:in:b', 'core', 'b:out', 'a:out']);
	});

	it("a plugin's transformPageChunk runs after ogygia's own", async () => {
		const core: Handle = ({ event, resolve }) =>
			resolve(event, { transformPageChunk: ({ html }) => html + '[core]' });
		const handle = around(
			[
				live('p', {
					handle: (_ctx, next) => next({ transformPageChunk: ({ html }) => html + '[plugin]' })
				})
			],
			core
		);
		let out = '';
		await handle({
			event: {} as never,
			resolve: async (_event, opts) => {
				out = (await opts!.transformPageChunk!({ html: '<html>', done: true })) ?? '';
				return new Response(out);
			}
		});
		expect(out).toBe('<html>[core][plugin]');
	});

	it('a plugin may answer without calling next()', async () => {
		let core_ran = false;
		const handle = around([live('p', { handle: () => new Response('mine') })], async () => {
			core_ran = true;
			return new Response('core');
		});
		const res = await handle({ event: {} as never, resolve: async () => new Response('') });
		expect(await res.text()).toBe('mine');
		expect(core_ran).toBe(false);
	});
});
