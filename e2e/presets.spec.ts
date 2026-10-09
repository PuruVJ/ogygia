// Transform-level checks for the region-model import syntax + presets + validation.
// Runs the built transform directly (no server needed). Usage: pnpm exec playwright test presets
import {
	transformHost,
	wrapperVirtualId
} from '../packages/ogygia/dist/compiler/region/transform.js';
import { CTX_EXTRA } from './_ctx-extra.ts';
import path from 'node:path';
import { test, check } from './fixtures/index.ts';
import { WRAPPER_VIRTUAL_RE } from './fixtures/re.ts';

const VISIBLE_200PX_RE = /visible=\{?"200px"\}?/;
const VISIBLE_0PX_RE = /visible=\{?"0px"\}?/;
const WRAPPER_TAG_RE = /<OgygiaRegion__Wrapper[^>]*/;
const HOST_KEEPS_C_RE = /<C\s*\/>/;
const ISLAND_LOAD_RE = /<OgygiaRegion__Wrapper __mode="island" load /;
const SERVER_WRAPPER_RE = /OgygiaRegion__Wrapper __mode="server"/;
const MEDIA_768_RE = /media=\{?"\(min-width: 768px\)"\}?/;
const UNKNOWN_PRESET_RE = /unknown preset 'nope'.*chart/s;
const NOT_ALLOWED_INLINE_RE = /not allowed inline/;
const ONLY_IMPORT_ATTRIBUTE_RE = /must be the only import attribute/;
const MODE_SERVER_RE = /__mode="server"/;
const DEFER_IDLE_RE = /__defer=\{"idle"\}/;
const HYDRATE_ATTR_RE = /__hydrate=/;
const MODULE_ATTR_RE = /__module=/;
const DEFER_VISIBLE_RE = /__defer=\{"visible"\}/;
const MARGIN_150PX_RE = /__margin=\{"150px"\}/;
const WAKE_FALSE_HINT_RE = /wake: 'false'.*use .*wake: 'none'/i;
const LAKE_WRAPPER_RE = /OgygiaRegion__Wrapper __mode="lake"/;
const HOST_CHILDREN_RE = /<Host\s*><p>x<\/p><\/Host>/;

const root = '/app';
const base_ctx = {
	...CTX_EXTRA,
	root,
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (_hostId: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
	wrapperPathFor: (_hostId: string, iid: string) => wrapperVirtualId(iid),
	devUrlFor: (p: string) => '/@id/' + p,
	visibleMargin: '0px',
	presets: {
		chart: { wake: 'visible', margin: '200px' },
		lazy: { wake: 'load', margin: '999px' }, // margin inapplicable to load -> tolerated
		srv: { render: 'deferred' }
	}
};
const HOST = '/app/src/routes/+page.svelte';
const run = (src: string, ctx = base_ctx) => transformHost(src, HOST, ctx);
const wrap = (imp: string, usage = '<C />') => `<script>\n${imp}\n</script>\n${usage}`;
const wrap_src = (r: ReturnType<typeof run>) => r?.islands?.[0]?.wrapperSource ?? '';
function expect_error(label: string, src: string, re: RegExp) {
	try {
		run(src);
		check(label + ' (throws)', false, 'no error thrown');
	} catch (e) {
		check(label, re.test((e as Error).message), (e as Error).message.slice(0, 90));
	}
}

test.describe('transform-level: region syntax + presets + errors', () => {
	test('presets + inline strategies', () => {
		// preset applies (visible + margin 200px)
		{
			const r = run(wrap(`import C from './C.svelte' with { preset: 'chart' };`));
			check(
				'preset chart -> visible with margin 200px',
				VISIBLE_200PX_RE.test(wrap_src(r)),
				wrap_src(r).match(WRAPPER_TAG_RE)?.[0]?.slice(0, 60)
			);
			check('preset chart -> host keeps <C />', HOST_KEEPS_C_RE.test(r!.code));
		}
		// preset tolerant: margin on a load preset is ignored, not an error
		{
			const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`));
			check(
				'preset lazy -> load strategy (inapplicable margin tolerated)',
				ISLAND_LOAD_RE.test(wrap_src(r))
			);
		}
		// preset defer -> server island
		{
			const r = run(
				wrap(
					`import C from './C.svelte' with { preset: 'srv' };`,
					'<C>{#snippet ogygiaFallback()}x{/snippet}</C>'
				)
			);
			check(
				'preset srv -> server island (ServerIsland wrapper)',
				SERVER_WRAPPER_RE.test(wrap_src(r))
			);
		}
		// inline hydrate visible uses the global default margin (0px)
		{
			const r = run(wrap(`import C from './C.svelte' with { wake: 'visible' };`));
			check(
				'inline hydrate visible -> global default margin 0px',
				VISIBLE_0PX_RE.test(wrap_src(r))
			);
		}
		// inline media query
		{
			const r = run(wrap(`import C from './C.svelte' with { wake: '(min-width: 768px)' };`));
			check('inline media query strategy', MEDIA_768_RE.test(wrap_src(r)));
		}
	});

	test('build errors + render: deferred', () => {
		// --- build errors ---
		expect_error(
			'unknown preset lists available',
			wrap(`import C from './C.svelte' with { preset: 'nope' };`),
			UNKNOWN_PRESET_RE
		);
		expect_error(
			'inline option key rejected (margin)',
			wrap(`import C from './C.svelte' with { wake: 'visible', margin: '9px' };`),
			NOT_ALLOWED_INLINE_RE
		);
		expect_error(
			'preset + another inline key rejected',
			wrap(`import C from './C.svelte' with { preset: 'chart', wake: 'load' };`),
			ONLY_IMPORT_ATTRIBUTE_RE
		);
		// render: deferred is content-only — a server island that never ships JS (Option A)
		{
			const r = run(
				wrap(
					`import C from './C.svelte' with { render: 'deferred', wake: 'idle' };`,
					'<C>{#snippet ogygiaFallback()}x{/snippet}</C>'
				)
			);
			check(
				'render: deferred -> server island, fetch on wake, no hydrate module',
				MODE_SERVER_RE.test(wrap_src(r)) &&
					DEFER_IDLE_RE.test(wrap_src(r)) &&
					!HYDRATE_ATTR_RE.test(wrap_src(r)) &&
					!MODULE_ATTR_RE.test(wrap_src(r))
			);
			check(
				'render: deferred -> kind defer + server true',
				r!.islands?.[0]?.kind === 'defer' && r!.islands?.[0]?.server === true
			);
		}
		// preset: a deferred hole fetched on visible threads the fetch margin
		{
			const ctx = {
				...base_ctx,
				presets: {
					...base_ctx.presets,
					srvVisible: { render: 'deferred', wake: 'visible', margin: '150px' }
				}
			};
			const r = run(
				wrap(
					`import C from './C.svelte' with { preset: 'srvVisible' };`,
					'<C>{#snippet ogygiaFallback()}x{/snippet}</C>'
				),
				ctx
			);
			check(
				'preset deferred+visible -> fetch margin threaded',
				DEFER_VISIBLE_RE.test(wrap_src(r)) && MARGIN_150PX_RE.test(wrap_src(r))
			);
		}
		expect_error(
			"hydrate 'false' errors and suggests 'none'",
			wrap(`import C from './C.svelte' with { wake: 'false' };`),
			WAKE_FALSE_HINT_RE
		);
	});

	test("lakes (wake: 'none') + host children + non-region attributes", () => {
		// --- lakes (wake: 'none') — portable lake wrapper ---
		{
			const r = run(wrap(`import Lake from './Lake.svelte' with { wake: 'none' };`, '<Lake />'));
			const lake = r?.islands?.find((i) => i.kind === 'lake');
			check(
				'lake binding -> LakeRegion wrapper source',
				!!lake?.wrapperSource && LAKE_WRAPPER_RE.test(lake.wrapperSource)
			);
			check(
				'lake binding -> placeholder local recorded',
				!!lake && lake.lakes?.includes('OgygiaLakeInner')
			);
			check('lake binding -> host import rewritten to wrapper', WRAPPER_VIRTUAL_RE.test(r!.code));
		}
		// host children on a hydrate island cross at RUNTIME (slot marker + adopting snippet): the
		// compiler leaves them at the call site and keeps the plain .js re-export entry.
		{
			const r = run(
				wrap(`import Host from './Host.svelte' with { wake: 'load' };`, '<Host><p>x</p></Host>')
			);
			const entry = r?.islands?.[0]?.virtualPath ?? '';
			check(
				'host children → plain .js entry (runtime slot crossing)',
				entry.endsWith('.js'),
				`entry=${entry}`
			);
			check('host children stay at the call site', HOST_CHILDREN_RE.test(r?.code ?? ''));
		}
		expect_error(
			'unknown key alongside a region key rejected',
			wrap(`import C from './C.svelte' with { wake: 'load', wat: 'x' };`),
			NOT_ALLOWED_INLINE_RE
		);
		{
			const r = run(wrap(`import data from './d.json' with { type: 'json' };`, '<p>{data}</p>'));
			check('non-region import attribute left alone (no transform)', r === null);
		}
	});
});
