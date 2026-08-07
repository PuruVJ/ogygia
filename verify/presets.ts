// Transform-level checks for the region-model import syntax + presets + validation.
// Runs the built transform directly (no server needed). Usage: node verify/presets.ts
import { transformHost, wrapperVirtualId } from '../packages/ogygia/dist/vite/transform.js';
import path from 'node:path';

let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const root = '/app';
const baseCtx = {
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
		chart: { hydrate: 'visible', margin: '200px' },
		lazy: { hydrate: 'load', margin: '999px' }, // margin inapplicable to load -> tolerated
		srv: { defer: 'load' }
	}
};
const HOST = '/app/src/routes/+page.svelte';
const run = (src: string, ctx = baseCtx) => transformHost(src, HOST, ctx);
const wrap = (imp: string, usage = '<C />') => `<script>\n${imp}\n</script>\n${usage}`;
const wrapSrc = (r: ReturnType<typeof run>) => r?.islands?.[0]?.wrapperSource ?? '';
function expectError(label: string, src: string, re: RegExp) {
	try {
		run(src);
		check(label + ' (throws)', false, 'no error thrown');
	} catch (e) {
		check(label, re.test((e as Error).message), (e as Error).message.slice(0, 90));
	}
}

// preset applies (visible + margin 200px)
{
	const r = run(wrap(`import C from './C.svelte' with { preset: 'chart' };`));
	check(
		'preset chart -> visible with margin 200px',
		/visible=\{?"200px"\}?/.test(wrapSrc(r)),
		wrapSrc(r).match(/<OgygiaIsland__Wrapper[^>]*/)?.[0]?.slice(0, 60)
	);
	check('preset chart -> host keeps <C />', /<C\s*\/>/.test(r!.code));
}
// preset tolerant: margin on a load preset is ignored, not an error
{
	const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`));
	check(
		'preset lazy -> load strategy (inapplicable margin tolerated)',
		/<OgygiaIsland__Wrapper load /.test(wrapSrc(r))
	);
}
// preset defer -> server island
{
	const r = run(
		wrap(`import C from './C.svelte' with { preset: 'srv' };`, '<C>{#snippet ogygiaFallback()}x{/snippet}</C>')
	);
	check('preset srv -> server island (ServerIsland wrapper)', /OgygiaServerIsland__Wrapper/.test(wrapSrc(r)));
}
// inline hydrate visible uses the global default margin (0px)
{
	const r = run(wrap(`import C from './C.svelte' with { hydrate: 'visible' };`));
	check('inline hydrate visible -> global default margin 0px', /visible=\{?"0px"\}?/.test(wrapSrc(r)));
}
// inline media query
{
	const r = run(wrap(`import C from './C.svelte' with { hydrate: '(min-width: 768px)' };`));
	check('inline media query strategy', /media=\{?"\(min-width: 768px\)"\}?/.test(wrapSrc(r)));
}

// --- build errors ---
expectError('unknown preset lists available', wrap(`import C from './C.svelte' with { preset: 'nope' };`), /unknown preset 'nope'.*chart/s);
expectError('inline option key rejected (margin)', wrap(`import C from './C.svelte' with { hydrate: 'visible', margin: '9px' };`), /not allowed inline/);
expectError('preset + another inline key rejected', wrap(`import C from './C.svelte' with { preset: 'chart', hydrate: 'load' };`), /must be the only import attribute/);
// defer + hydrate is supported (deferred client island)
{
	const r = run(wrap(`import C from './C.svelte' with { defer: 'load', hydrate: 'load' };`));
	check(
		'defer + hydrate -> ServerIsland with __hydrate + __module',
		/__hydrate=\{"load"\}/.test(wrapSrc(r)) && /__module=\{/.test(wrapSrc(r))
	);
	check(
		'defer + hydrate -> kind hydrate + server true',
		r!.islands?.[0]?.kind === 'hydrate' && r!.islands?.[0]?.server === true
	);
}
// preset with defer+hydrate+margin
{
	const ctx = {
		...baseCtx,
		presets: {
			...baseCtx.presets,
			lazyClient: { defer: 'load', hydrate: 'visible', margin: '150px' }
		}
	};
	const r = run(wrap(`import C from './C.svelte' with { preset: 'lazyClient' };`), ctx);
	check(
		'preset defer+hydrate+margin -> hydrateMargin threaded',
		/__hydrate=\{"visible"\}/.test(wrapSrc(r)) && /__hydrateMargin=\{"150px"\}/.test(wrapSrc(r))
	);
}
// matching schedules still emit both attrs (runtime coalesce)
{
	const r = run(wrap(`import C from './C.svelte' with { defer: 'idle', hydrate: 'idle' };`));
	check(
		'matching defer+hydrate still emits both schedules at transform',
		/__defer=\{"idle"\}/.test(wrapSrc(r)) && /__hydrate=\{"idle"\}/.test(wrapSrc(r))
	);
}
expectError("hydrate 'false' errors and suggests 'none'", wrap(`import C from './C.svelte' with { hydrate: 'false' };`), /hydrate: 'false'.*use .*hydrate: 'none'/i);

// --- lakes (hydrate: 'none') — portable lake wrapper ---
{
	const r = run(wrap(`import Lake from './Lake.svelte' with { hydrate: 'none' };`, '<Lake />'));
	const lake = r?.islands?.find((i) => i.kind === 'lake');
	check(
		'lake binding -> LakeRegion wrapper source',
		!!lake?.wrapperSource && /OgygiaLakeRegion__Wrapper/.test(lake.wrapperSource)
	);
	check('lake binding -> placeholder local recorded', !!lake && lake.lakes?.includes('OgygiaLakeInner'));
	check('lake binding -> host import rewritten to wrapper', /virtual:ogygia\/wrapper\//.test(r!.code));
}
// host children on hydrate island rejected (lakes must live inside the island component)
expectError(
	'host children on hydrate island rejected',
	wrap(
		`import Host from './Host.svelte' with { hydrate: 'load' };\nimport Lake from './Lake.svelte' with { hydrate: 'none' };`,
		'<Host><Lake /></Host>'
	),
	/host children/
);
expectError('unknown key alongside a region key rejected', wrap(`import C from './C.svelte' with { hydrate: 'load', wat: 'x' };`), /not allowed inline/);
{
	const r = run(wrap(`import data from './d.json' with { type: 'json' };`, '<p>{data}</p>'));
	check('non-region import attribute left alone (no transform)', r === null);
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PRESET/SYNTAX CHECKS PASSED' : failures + ' PRESET/SYNTAX CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
