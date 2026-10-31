// ONE KIT: ogygia reads Kit's request store (`@sveltejs/kit/internal/server`), so Kit must resolve
// from the app, never from ogygia's own location: a workspace-linked ogygia whose peer resolved
// another Kit than the app's had its own, empty store — the devtools' server events, the freeze
// verdict's reads and the page seed's request were all lost, silently (the upstream watcher caught
// it the day the app's Kit moved to 3.1.0 and ogygia's peer stayed on 3.0.1).
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ogygia } from '../src/vite/index.ts';

const palaestra = fileURLToPath(new URL('../../../apps/palaestra', import.meta.url));

type Hook = ((c: object, e: object) => unknown) | { handler: (c: object, e: object) => unknown };

describe('one Kit', () => {
	it('the plugin dedupes @sveltejs/kit, in dev and in a build', async () => {
		for (const command of ['serve', 'build'] as const) {
			const plugins = ([] as unknown[]).concat(ogygia({})).flat() as { config?: Hook }[];
			let dedupe: string[] = [];
			for (const p of plugins) {
				const hook = p.config;
				if (!hook) continue;
				const run = typeof hook === 'function' ? hook : hook.handler;
				const out = (await run(
					{ root: palaestra },
					{ command, mode: command === 'serve' ? 'development' : 'production' }
				)) as { resolve?: { dedupe?: string[] } } | undefined;
				dedupe = dedupe.concat(out?.resolve?.dedupe ?? []);
			}
			expect(dedupe, command).toContain('@sveltejs/kit');
		}
	});
});
