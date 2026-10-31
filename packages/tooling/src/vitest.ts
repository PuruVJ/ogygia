import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { ViteUserConfig } from 'vitest/config';

/** Core's test stubs: `app-<name>.ts` stands in for `$app/<name>`, `virtual-<name>.ts` for
 *  `virtual:ogygia/<name>` (packages/ogygia/test/_stubs). */
const STUBS = fileURLToPath(new URL('../../ogygia/test/_stubs/', import.meta.url));

function stub_aliases(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const file of readdirSync(STUBS)) {
		const name = file.replace(/\.ts$/, '');
		if (name.startsWith('app-')) out['$app/' + name.slice(4)] = STUBS + file;
		else if (name.startsWith('virtual-')) out['virtual:ogygia/' + name.slice(8)] = STUBS + file;
	}
	return out;
}

/**
 * The unit-test setup every ogygia plugin package shares: node environment, the Svelte plugin (core's
 * source reaches `.svelte` files), and core's stubs for Kit's `$app/*` and ogygia's virtual modules,
 * so a plugin's tests run against core's real source without a Kit app or the Vite plugin.
 */
export function pluginTests(): ViteUserConfig {
	return {
		plugins: [svelte()],
		resolve: { alias: stub_aliases() },
		test: { include: ['test/**/*.test.ts'], environment: 'node' }
	};
}
