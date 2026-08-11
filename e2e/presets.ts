// Transform-level checks for the region-model import syntax + presets + validation.
// Runs the built transform directly (no server needed). Usage: node verify/presets.ts
import { transformHost, wrapperVirtualId } from '../packages/ogygia/dist/compiler/transform.js';
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
		chart: { wake: 'visible', margin: '200px' },
		lazy: { wake: 'load', margin: '999px' }, // margin inapplicable to load -> tolerated
		srv: { render: 'deferred' }
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
		wrapSrc(r).match(/<OgygiaRegion__Wrapper[^>]*/)?.[0]?.slice(0, 60)
	);
	check('preset chart -> host keeps <C />', /<C\s*\/>/.test(r!.code));
}
// preset tolerant: margin on a load preset is ignored, not an error
{
	const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`));
	check(
		'preset lazy -> load strategy (inapplicable margin tolerated)',
		/<OgygiaRegion__Wrapper __mode="island" load /.test(wrapSrc(r))
	);
}
// preset defer -> server island
{
	const r = run(
		wrap(`import C from './C.svelte' with { preset: 'srv' };`, '<C>{#snippet ogygiaFallback()}x{/snippet}</C>')
	);
	check('preset srv -> server island (ServerIsland wrapper)', /OgygiaRegion__Wrapper __mode="server"/.test(wrapSrc(r)));
}
// inline hydrate visible uses the global default margin (0px)
{
	const r = run(wrap(`import C from './C.svelte' with { wake: 'visible' };`));
	check('inline hydrate visible -> global default margin 0px', /visible=\{?"0px"\}?/.test(wrapSrc(r)));
}
// inline media query
{
	const r = run(wrap(`import C from './C.svelte' with { wake: '(min-width: 768px)' };`));
	check('inline media query strategy', /media=\{?"\(min-width: 768px\)"\}?/.test(wrapSrc(r)));
}

// --- build errors ---
expectError('unknown preset lists available', wrap(`import C from './C.svelte' with { preset: 'nope' };`), /unknown preset 'nope'.*chart/s);
expectError('inline option key rejected (margin)', wrap(`import C from './C.svelte' with { wake: 'visible', margin: '9px' };`), /not allowed inline/);
expectError('preset + another inline key rejected', wrap(`import C from './C.svelte' with { preset: 'chart', wake: 'load' };`), /must be the only import attribute/);
// render: deferred is content-only — a server island that never ships JS (Option A)
{
	const r = run(wrap(`import C from './C.svelte' with { render: 'deferred', wake: 'idle' };`, '<C>{#snippet ogygiaFallback()}x{/snippet}</C>'));
	check(
		'render: deferred -> server island, fetch on wake, no hydrate module',
		/__mode="server"/.test(wrapSrc(r)) && /__defer=\{"idle"\}/.test(wrapSrc(r)) && !/__hydrate=/.test(wrapSrc(r)) && !/__module=/.test(wrapSrc(r))
	);
	check(
		'render: deferred -> kind defer + server true',
		r!.islands?.[0]?.kind === 'defer' && r!.islands?.[0]?.server === true
	);
}
// preset: a deferred hole fetched on visible threads the fetch margin
{
	const ctx = {
		...baseCtx,
		presets: {
			...baseCtx.presets,
			srvVisible: { render: 'deferred', wake: 'visible', margin: '150px' }
		}
	};
	const r = run(wrap(`import C from './C.svelte' with { preset: 'srvVisible' };`, '<C>{#snippet ogygiaFallback()}x{/snippet}</C>'), ctx);
	check(
		'preset deferred+visible -> fetch margin threaded',
		/__defer=\{"visible"\}/.test(wrapSrc(r)) && /__margin=\{"150px"\}/.test(wrapSrc(r))
	);
}
expectError("hydrate 'false' errors and suggests 'none'", wrap(`import C from './C.svelte' with { wake: 'false' };`), /wake: 'false'.*use .*wake: 'none'/i);

// --- lakes (wake: 'none') — portable lake wrapper ---
{
	const r = run(wrap(`import Lake from './Lake.svelte' with { wake: 'none' };`, '<Lake />'));
	const lake = r?.islands?.find((i) => i.kind === 'lake');
	check(
		'lake binding -> LakeRegion wrapper source',
		!!lake?.wrapperSource && /OgygiaRegion__Wrapper __mode="lake"/.test(lake.wrapperSource)
	);
	check('lake binding -> placeholder local recorded', !!lake && lake.lakes?.includes('OgygiaLakeInner'));
	check('lake binding -> host import rewritten to wrapper', /virtual:ogygia\/wrapper\//.test(r!.code));
}
// host children on a hydrate island now CROSS: the compiler ships them as a synthesized `.svelte`
// entry that inlines the snippet and wraps the real component.
{
	const r = run(wrap(`import Host from './Host.svelte' with { wake: 'load' };`, '<Host><p>x</p></Host>'));
	const entry = r?.islands?.[0]?.virtualPath ?? '';
	check('host children cross → synthesized .svelte entry', entry.endsWith('.svelte'), `entry=${entry}`);
	check('host children entry inlines the real component', /OgygiaChildTarget/.test(r?.islands?.[0]?.source ?? ''));
}
expectError('unknown key alongside a region key rejected', wrap(`import C from './C.svelte' with { wake: 'load', wat: 'x' };`), /not allowed inline/);
{
	const r = run(wrap(`import data from './d.json' with { type: 'json' };`, '<p>{data}</p>'));
	check('non-region import attribute left alone (no transform)', r === null);
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PRESET/SYNTAX CHECKS PASSED' : failures + ' PRESET/SYNTAX CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
