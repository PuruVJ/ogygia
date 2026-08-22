// Comprehensive unit suite for the PURE npm-resolution logic (no network). Run: `node npm-resolve.test.mjs`.
// Covers the gnarly real-world patterns: scopes, embedded versions, subpaths, `exports` conditions +
// wildcards, the `browser` field (string + object + false-stub), and the module/main/index fallback chain.
import {
	parse_specifier,
	resolve_exports,
	apply_browser_map,
	resolve_entry,
	extension_candidates,
	is_bare,
	BROWSER_STUB
} from './npm-resolve.ts';

let pass = 0;
let fail = 0;
const eq = (label, got, want) => {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	if (g === w) {
		pass++;
	} else {
		fail++;
		console.log(`  ✗ ${label}\n      got:  ${g}\n      want: ${w}`);
	}
};
const group = (name) => console.log(`\n${name}`);

// ── is_bare ──
group('is_bare');
eq('bare pkg', is_bare('lodash'), true);
eq('scoped', is_bare('@org/pkg'), true);
eq('relative', is_bare('./x'), false);
eq('parent', is_bare('../x'), false);
eq('absolute', is_bare('/x'), false);
eq('url', is_bare('https://x/y'), false);
eq('data url', is_bare('data:x'), false);

// ── parse_specifier ──
group('parse_specifier');
eq('plain', parse_specifier('lodash'), { name: 'lodash', version: '', subpath: '' });
eq('subpath', parse_specifier('lodash/debounce'), { name: 'lodash', version: '', subpath: 'debounce' });
eq('deep subpath', parse_specifier('lodash/fp/curry'), { name: 'lodash', version: '', subpath: 'fp/curry' });
eq('version', parse_specifier('lodash@4.17.21'), { name: 'lodash', version: '4.17.21', subpath: '' });
eq('version + subpath', parse_specifier('lodash@4.17.21/debounce'), { name: 'lodash', version: '4.17.21', subpath: 'debounce' });
eq('scoped', parse_specifier('@floating-ui/dom'), { name: '@floating-ui/dom', version: '', subpath: '' });
eq('scoped + subpath', parse_specifier('@floating-ui/dom/dist/x.js'), { name: '@floating-ui/dom', version: '', subpath: 'dist/x.js' });
eq('scoped + version', parse_specifier('@floating-ui/dom@1.6.0'), { name: '@floating-ui/dom', version: '1.6.0', subpath: '' });
eq('scoped + version + subpath', parse_specifier('@org/pkg@1.2.3/sub/deep'), { name: '@org/pkg', version: '1.2.3', subpath: 'sub/deep' });
eq('tag version', parse_specifier('svelte@next'), { name: 'svelte', version: 'next', subpath: '' });

// ── resolve_exports ──
group('resolve_exports');
eq('string shorthand root', resolve_exports('./main.mjs', '.'), './main.mjs');
eq('string shorthand no subpath', resolve_exports('./main.mjs', 'sub'), null);
eq('conditions object (import wins)', resolve_exports({ import: './m.mjs', require: './m.cjs', default: './m.js' }, '.'), './m.mjs');
eq('conditions object (browser wins over import)', resolve_exports({ browser: './b.mjs', import: './m.mjs' }, '.'), './b.mjs');
eq('conditions fall to default', resolve_exports({ require: './m.cjs', default: './m.js' }, '.'), './m.js');
eq('nested conditions', resolve_exports({ '.': { import: { browser: './ib.mjs', default: './i.mjs' } } }, '.'), './ib.mjs');
eq('subpath map root', resolve_exports({ '.': './index.mjs', './sub': './sub.mjs' }, '.'), './index.mjs');
eq('subpath map sub', resolve_exports({ '.': './index.mjs', './sub': './sub.mjs' }, 'sub'), './sub.mjs');
eq('subpath map sub conditions', resolve_exports({ './sub': { import: './sub.mjs', default: './sub.js' } }, 'sub'), './sub.mjs');
eq('wildcard', resolve_exports({ './*': './dist/*.js' }, 'foo'), './dist/foo.js');
eq('wildcard deep', resolve_exports({ './*': './dist/*.js' }, 'foo/bar'), './dist/foo/bar.js');
eq('wildcard with ext', resolve_exports({ './*.js': './dist/*.js' }, 'foo.js'), './dist/foo.js');
eq('exact beats wildcard', resolve_exports({ './special': './special.mjs', './*': './dist/*.js' }, 'special'), './special.mjs');
eq('longest wildcard prefix wins', resolve_exports({ './*': './a/*.js', './feature/*': './b/*.js' }, 'feature/x'), './b/x.js');
eq('@floating-ui real shape', resolve_exports({ '.': { import: { default: './dist/floating-ui.dom.mjs' }, module: './dist/floating-ui.dom.esm.js', default: './dist/floating-ui.dom.umd.js' } }, '.'), './dist/floating-ui.dom.mjs');
eq('no match', resolve_exports({ './a': './a.js' }, 'b'), null);

// ── apply_browser_map ──
group('apply_browser_map');
eq('string browser is not a map', apply_browser_map('./browser.js', './server.js'), './server.js');
eq('object remap', apply_browser_map({ './server.js': './browser.js' }, './server.js'), './browser.js');
eq('object remap (no ./ in key)', apply_browser_map({ 'server.js': './browser.js' }, './server.js'), './browser.js');
eq('object stub (false)', apply_browser_map({ './node-only.js': false }, './node-only.js'), BROWSER_STUB);
eq('object no match', apply_browser_map({ './a.js': './b.js' }, './c.js'), './c.js');
eq('undefined browser', apply_browser_map(undefined, './x.js'), './x.js');

// ── resolve_entry (real + synthetic package.json) ──
group('resolve_entry');
// canvas-confetti: module (ESM) preferred over main (CJS)
eq('module over main', resolve_entry({ main: 'src/confetti.js', module: 'dist/confetti.module.mjs' }, ''), 'dist/confetti.module.mjs');
// lodash: only main (CJS)
eq('main only', resolve_entry({ main: 'lodash.js' }, ''), 'lodash.js');
// no fields → index.js
eq('index fallback', resolve_entry({}, ''), 'index.js');
// exports wins over module/main
eq('exports wins', resolve_entry({ main: 'main.js', module: 'm.mjs', exports: { '.': { import: './e.mjs' } } }, ''), 'e.mjs');
// @floating-ui/dom real
eq('floating-ui exports', resolve_entry({ main: './dist/floating-ui.dom.umd.js', module: './dist/floating-ui.dom.esm.js', exports: { '.': { import: { default: './dist/floating-ui.dom.mjs' }, module: './dist/floating-ui.dom.esm.js', default: './dist/floating-ui.dom.umd.js' } } }, ''), 'dist/floating-ui.dom.mjs');
// browser string replaces main
eq('browser string entry', resolve_entry({ main: 'server.js', browser: 'browser.js' }, ''), 'browser.js');
// browser object remaps main
eq('browser object remaps main', resolve_entry({ main: './index.js', browser: { './index.js': './index.browser.js' } }, ''), 'index.browser.js');
// subpath with no exports → literal file (+ browser remap)
eq('subpath literal', resolve_entry({ main: 'lodash.js' }, 'debounce'), 'debounce');
eq('subpath browser remap', resolve_entry({ browser: { './server.js': './client.js' } }, 'server.js'), 'client.js');
// subpath via exports
eq('subpath via exports', resolve_entry({ exports: { './feature': { import: './dist/feature.mjs' } } }, 'feature'), 'dist/feature.mjs');
// exports present but subpath not mapped → literal fallthrough
eq('exports miss → literal', resolve_entry({ exports: { '.': './index.mjs' } }, 'extra/file.js'), 'extra/file.js');
// SVELTE condition in exports (radix-svelte / bits-ui shape) — critical for svelte libs
eq('svelte export condition (radix-svelte)', resolve_entry({ type: 'module', svelte: './dist/index.js', exports: { '.': { types: './dist/index.d.ts', svelte: './dist/index.js' } } }, ''), 'dist/index.js');
eq('svelte condition wins over default', resolve_entry({ exports: { '.': { svelte: './svelte-entry.js', default: './dist/index.js' } } }, ''), 'svelte-entry.js');
// top-level svelte FIELD (no exports) — older svelte libs
eq('svelte field (no exports)', resolve_entry({ module: './dist/module.js', main: './dist/main.js', svelte: './src/index.js' }, ''), 'src/index.js');

// ── extension_candidates ──
group('extension_candidates');
eq('no ext', extension_candidates('./x'), ['./x', './x.mjs', './x.js', './x.cjs', './x.json', './x/index.mjs', './x/index.js', './x/index.cjs', './x/index.json']);
eq('with ext (file only)', extension_candidates('./x.js'), ['./x.js']);
eq('json ext (file only)', extension_candidates('./data.json'), ['./data.json']);

console.log(`\n${'─'.repeat(40)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
