import { describe, expect, it } from 'vitest';
import { app_relative } from '../src/profiler/app-path.js';
import { short_source } from '../src/profiler/ledger.js';

// One app's files read one way, from the app's folder, whatever their depth.

describe('app_relative', () => {
	const root = process.cwd().split('\\').join('/');
	it('a file under the app folder reads from there; the build output and packages do not', () => {
		expect(app_relative(`${root}/src/hooks.server.ts`)).toBe('src/hooks.server.ts');
		expect(app_relative(`${root}/src/routes/a/b/c/+page.svelte`)).toBe(
			'src/routes/a/b/c/+page.svelte'
		);
		expect(app_relative(`${root}/.svelte-kit/output/server/chunks/x.js`)).toBeUndefined();
		expect(app_relative(`${root}/node_modules/p/i.js`)).toBeUndefined();
		expect(app_relative('/elsewhere/src/x.ts')).toBeUndefined();
	});

	it('the ledger labels a nested src/ folder from the app root, not from the innermost src/', () => {
		expect(short_source(`${root}/src/shims/lib/src/components/A.svelte`)).toBe(
			'src/shims/lib/src/components/A.svelte'
		);
	});
});
