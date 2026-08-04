// Transform-level checks for the region-model import syntax + presets + validation.
// Runs the built transform directly (no server needed). Usage: node verify/presets.ts
import { transformHost } from '../packages/ogygia/dist/vite/transform.js';
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
	virtualPathFor: (hostId: string, iid: string) => path.join(path.dirname(hostId), '.ogygia', iid + '.svelte'),
	devUrlFor: (p: string) => '/' + path.relative(root, p),
	scriptPathFor: (hostId: string, hash: string, ext: string) => path.join(path.dirname(hostId), '.ogygia', hash + '.script' + ext),
	scriptUrlFor: (_p: string, hash: string) => '/' + hash,
	visibleMargin: '0px',
	presets: {
		chart: { hydrate: 'visible', margin: '200px' },
		lazy: { hydrate: 'load', margin: '999px' }, // margin inapplicable to load -> tolerated
		srv: { defer: 'true' }
	}
};
const HOST = '/app/src/routes/+page.svelte';
const run = (src: string, ctx = baseCtx) => transformHost(src, HOST, ctx);
const wrap = (imp: string, usage = '<C />') => `<script>\n${imp}\n</script>\n${usage}`;
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
	check('preset chart -> visible with margin 200px', /visible=\{?"200px"\}?/.test(r.code), r.code.match(/<OgygiaIsland__Wrapper[^>]*/)?.[0]?.slice(0, 60));
}
// preset tolerant: margin on a load preset is ignored, not an error
{
	const r = run(wrap(`import C from './C.svelte' with { preset: 'lazy' };`));
	check('preset lazy -> load strategy (inapplicable margin tolerated)', /<OgygiaIsland__Wrapper load /.test(r.code));
}
// preset defer -> server island (no ogygia-region wrapper import, uses ServerIsland)
{
	const r = run(wrap(`import C from './C.svelte' with { preset: 'srv' };`, '<C>{#snippet fallback()}x{/snippet}</C>'));
	check('preset srv -> server island (ServerIsland wrapper)', /OgygiaServerIsland__Wrapper/.test(r.code));
}
// inline hydrate visible uses the global default margin (0px)
{
	const r = run(wrap(`import C from './C.svelte' with { hydrate: 'visible' };`));
	check('inline hydrate visible -> global default margin 0px', /visible=\{?"0px"\}?/.test(r.code));
}
// inline media query
{
	const r = run(wrap(`import C from './C.svelte' with { hydrate: '(min-width: 768px)' };`));
	check('inline media query strategy', /media=\{?"\(min-width: 768px\)"\}?/.test(r.code));
}

// --- build errors ---
expectError('unknown preset lists available', wrap(`import C from './C.svelte' with { preset: 'nope' };`), /unknown preset 'nope'.*chart/s);
expectError('inline option key rejected (margin)', wrap(`import C from './C.svelte' with { hydrate: 'visible', margin: '9px' };`), /not allowed inline/);
expectError('preset + another inline key rejected', wrap(`import C from './C.svelte' with { preset: 'chart', hydrate: 'load' };`), /must be the only import attribute/);
expectError('defer + hydrate is a roadmap error', wrap(`import C from './C.svelte' with { defer: 'true', hydrate: 'load' };`), /not yet supported \(roadmap/);
expectError('hydrate false (lakes) is a roadmap error', wrap(`import C from './C.svelte' with { hydrate: 'false' };`), /lakes.*not yet supported/i);
expectError('unknown key alongside a region key rejected', wrap(`import C from './C.svelte' with { hydrate: 'load', wat: 'x' };`), /not allowed inline/);
// an import with ONLY a non-region attribute (e.g. an import assertion) is left alone, not a region
{
	const r = run(wrap(`import data from './d.json' with { type: 'json' };`, '<p>{data}</p>'));
	check('non-region import attribute left alone (no transform)', r === null);
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PRESET/SYNTAX CHECKS PASSED' : failures + ' PRESET/SYNTAX CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
