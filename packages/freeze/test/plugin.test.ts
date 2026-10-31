/**
 * The freeze plugin as core sees it: its Vite value (name, normalized options, the `freeze` route
 * option it reads) and its server realm started the way the handle starts it — the shared hooks
 * it calls (`invalidated`) and answers (`lastBuild`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startPlugin } from 'ogygia/plugin/testing';
import { register_hooks, ask } from '../../ogygia/src/plugin/hooks.js';
import { freeze as freezePlugin } from '../src/vite.js';
import server, { type FreezeServerOptions } from '../src/server.js';
import { freeze } from '../src/index.js';
import { reset_for_tests } from '../src/registry.js';

// The server half reads Kit's `$app/env`; outside an app, nothing is building and this is no dev server.
vi.mock('$app/env', () => ({ building: false, dev: false }));

describe('freeze() — the vite value', () => {
	it('names the package and normalizes its options', () => {
		const plugin = freezePlugin();
		expect(plugin.name).toBe('@ogygia/freeze');
		expect(plugin.options).toEqual({ ttl: 86400, default: true });
		expect(freezePlugin({ ttl: 999_999 }).options?.ttl).toBe(86400);
		expect(freezePlugin({ ttl: 0 }).options?.ttl).toBe(1);
		expect(freezePlugin({ ttl: 12.7 }).options?.ttl).toBe(12);
		expect(freezePlugin({ default: false }).options?.default).toBe(false);
	});

	it('its build hook registers the `freeze` route option', () => {
		const names: string[] = [];
		freezePlugin().build!({
			root: '/',
			dev: true,
			routeOption: (n) => void names.push(n),
			foreignHydrate: () => {},
			macro: () => {},
			markup: () => ({ transform: () => null })
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
		const leave = register_hooks({ invalidated: (tags: string[] | 'all') => void heard.push(tags) });
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
