/**
 * The freeze plugin as core sees it: its Vite value (name, normalized options, the `freeze` route
 * option it reads) and its server realm started the way the handle starts it — the shared hooks
 * it calls (`invalidated`) and answers (`lastBuild`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startPlugin } from '@ogygia/core/plugin/testing';
import { register_hooks, ask } from '../../core/src/plugin/hooks.ts';
import type { PluginDefinition } from '@ogygia/core/vite';
import { freeze as freezePlugin } from '../src/vite.ts';
import server, { type FreezeServerOptions } from '../src/server.ts';
import { freeze } from '../src/index.ts';
import { reset_for_tests } from '../src/registry.ts';

/** the definition `definePlugin` put on the Vite plugin */
const definition = (plugin: ReturnType<typeof freezePlugin>) =>
	(plugin as unknown as Record<symbol, PluginDefinition<FreezeServerOptions>>)[
		Symbol.for('ogygia.plugin')
	];

// The server half reads Kit's `$app/env`; outside an app, nothing is building and this is no dev server.
vi.mock('$app/env', () => ({ building: false, dev: false }));

describe('freeze() — the vite value', () => {
	it('names the package and normalizes its options', () => {
		const plugin = freezePlugin();
		const options = (o?: Parameters<typeof freezePlugin>[0]) => definition(freezePlugin(o)).options;
		expect(plugin.name).toBe('@ogygia/freeze');
		expect(options()).toEqual({ ttl: 86400, default: true });
		expect(options({ ttl: 999_999 })?.ttl).toBe(86400);
		expect(options({ ttl: 0 })?.ttl).toBe(1);
		expect(options({ ttl: 12.7 })?.ttl).toBe(12);
		expect(options({ default: false })?.default).toBe(false);
	});

	it('its build hook registers the `freeze` route option', () => {
		const names: string[] = [];
		definition(freezePlugin()).build!({
			root: '/',
			dev: true,
			routeOption: (n) => void names.push(n),
			foreignHydrate: () => {},
			macro: () => {},
			markup: () => ({ transform: () => null }),
			events: () => {},
			measure: () => {},
			files: () => {},
			pageModules: () => {}
		});
		expect(names).toEqual(['freeze']);
	});
});

describe('the server realm, started', () => {
	const options: FreezeServerOptions = { ttl: 60, default: true };
	startPlugin(server, { name: '@ogygia/freeze', options });
	afterEach(() => reset_for_tests());

	it('an invalidation announces what it dropped through the shared `invalidated` hook', async () => {
		const heard: (string[] | 'all')[] = [];
		const leave = register_hooks({
			invalidated: (tags: string[] | 'all') => void heard.push(tags)
		});
		try {
			await freeze.invalidate('/x');
			await freeze.invalidateWhere({ prefix: '/a/' });
			await Promise.resolve();
			expect(heard).toEqual([['p:/x'], 'all']);
		} finally {
			leave();
		}
	});

	it('answers `lastBuild`: nothing the first time, the previous build after that', async () => {
		expect(await ask.lastBuild('v1')).toBeUndefined();
		expect(await ask.lastBuild('v2')).toBe('v1');
	});
});
