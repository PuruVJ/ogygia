import { describe, expect, it } from 'vitest';
import { handle_parts } from '../src/profiler/source-scan.js';
import { phase_of_stack } from '../src/profiler/timeline.js';

const reader = (text: string) => (_p: string, a: number, b: number) => {
	const lines = text.split('\n');
	return { start: a, lines: lines.slice(a - 1, b) };
};

describe('handle_parts: the handle functions a hooks file borrows from other modules', () => {
	it('reads sequence(...) and follows the imports to their files', () => {
		const src = [
			"import { sequence } from '@sveltejs/kit/hooks';",
			"import { redirect, type Handle } from '@sveltejs/kit';",
			"import { handle as ogygiaHandle } from 'ogygia/server';",
			"import { ds_ssr } from '$lib/hell/ds-ssr';",
			"import {",
			'\tguard as authGuard,',
			'\tother',
			"} from './auth.js';",
			'const local: Handle = async ({ event, resolve }) => resolve(event);',
			'export const handle: Handle = sequence(',
			'\t// the design-system pass',
			'\tds_ssr,',
			'\tauthGuard,',
			'\togygiaHandle(),',
			'\tlocal',
			');'
		].join('\n');
		const parts = handle_parts(reader(src), 'src/hooks.server.ts');
		// the exported name, with its module's stem; not the package handle, the factory call or the local
		expect([...parts]).toEqual([
			['ds_ssr', 'ds-ssr'],
			['guard', 'auth']
		]);
	});

	it('takes a handle that is one imported function', () => {
		const src = "import { mine } from '../lib/mine';\nexport const handle = mine;";
		expect([...handle_parts(reader(src), 'hooks.server.ts')]).toEqual([['mine', 'mine']]);
	});

	it('the phase: that function in its own file reads as hooks, the same name elsewhere does not', () => {
		const hooks = new Map([['ds_ssr', 'ds-ssr']]);
		const leaf = { name: '(anonymous)', url: '/app/src/lib/hell/ds-ssr.ts', line: 62, category: 'app' as const };
		const root = { name: 'ds_ssr', url: '/app/src/lib/hell/ds-ssr.ts', line: 214, category: 'app' as const };
		expect(phase_of_stack([leaf, root], hooks)).toBe('hooks');
		expect(phase_of_stack([leaf, root])).toBe('other');
		expect(phase_of_stack([{ ...root, url: '/app/src/lib/my-ds-ssr.ts' }], hooks)).toBe('other');
		// after an await the stack roots at the function that resumed, not the handle: its file says it
		const resumed = { name: 'processDsTags', url: '/app/src/lib/hell/ds-ssr.ts', line: 35, category: 'app' as const };
		const span = { name: 'span', url: '/app/node_modules/ogygia/dist/profiler/span.js', line: 103, category: 'dependency' as const };
		expect(phase_of_stack([leaf, span, resumed], hooks)).toBe('hooks');
		// a component under the hook is still render: the deepest frame decides
		expect(phase_of_stack([{ name: 'Card', url: '/app/src/Card.svelte', line: 1, category: 'component' }, root], hooks)).toBe('render');
	});
});
