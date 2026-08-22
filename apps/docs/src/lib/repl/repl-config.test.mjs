// Unit coverage for the REPL's vite.config parser — extracting the safe `ogygia({ content: { markdown } })`
// options and degrading gracefully on imports / unknowns / malformed input. Run: `node repl-config.test.mjs`.
import { parse_config_markdown, extract_call_object } from './repl-config.ts';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

console.log('repl-config parser\n');

// ── extract_call_object ──────────────────────────────────────────────────────────────────────────
ok('extract: simple call', extract_call_object('ogygia({ a: 1 })', 'ogygia') === '{ a: 1 }');
ok('extract: nested braces', extract_call_object('ogygia({ a: { b: { c: 1 } } })', 'ogygia') === '{ a: { b: { c: 1 } } }');
ok('extract: brace inside a string is ignored', extract_call_object(`ogygia({ t: "a{b}c" })`, 'ogygia') === `{ t: "a{b}c" }`);
ok('extract: whitespace/newlines before {', extract_call_object('ogygia(\n  {\n a: 1\n }\n)', 'ogygia') === '{\n a: 1\n }');
ok('extract: no call → null', extract_call_object('export default {}', 'ogygia') === null);
ok('extract: call with no object arg → null', extract_call_object('ogygia(foo)', 'ogygia') === null);

// ── parse_config_markdown ────────────────────────────────────────────────────────────────────────
const full = `import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { diff_markers, inline_markers } from 'ogygia/content/markdown';
import customTheme from './theme.json';
export default { plugins: [ ogygia({
  content: { markdown: {
    containers: false,
    tabs: true,
    headingAnchors: false,
    themes: { light: 'nord', dark: 'dracula' },
    code: { transformers: [diff_markers(), inline_markers()] },
  } } }), sveltekit() ] };`;
{
	const c = parse_config_markdown(full);
	ok('parses containers/tabs/headingAnchors', c && c.containers === false && c.tabs === true && c.headingAnchors === false);
	ok('parses string themes', c && c.themes?.light === 'nord' && c.themes?.dark === 'dracula');
	ok('keeps the two named transformers (real objects)', c && Array.isArray(c.code?.transformers) && c.code.transformers.length === 2);
	ok('sandbox ignores unrelated imports (sveltekit/customTheme) without throwing', !!c);
}
// a theme OBJECT (from an import) → dropped (only string names survive)
{
	const c = parse_config_markdown(`ogygia({ content: { markdown: { themes: { light: customTheme, dark: 'x' } } } })`);
	ok('imported theme object dropped, string kept', c && c.themes?.dark === 'x' && c.themes?.light === undefined);
}
// a custom transformer (unknown identifier) → stubbed → dropped; known ones survive
{
	const c = parse_config_markdown(`ogygia({ content: { markdown: { code: { transformers: [diff_markers(), myCustom()] } } } })`);
	ok('custom transformer dropped, diff kept', c && c.code?.transformers?.length === 1);
}
// top-level `markdown` (not under content) also read
{
	const c = parse_config_markdown(`ogygia({ markdown: { tabs: false } })`);
	ok('top-level markdown key read', c && c.tabs === false);
}
// no ogygia call → null; malformed → null (no throw)
ok('no ogygia() → null', parse_config_markdown('export default { plugins: [sveltekit()] }') === null);
ok('malformed object → null (no throw)', parse_config_markdown('ogygia({ a: = = broken')  === null);
// unsafe keys are NOT copied (only the whitelisted subset)
{
	const c = parse_config_markdown(`ogygia({ content: { markdown: { containers: true, loader: somethingNasty, remark: [evil()] } } })`);
	ok('unsafe keys (loader/remark) not copied', c && c.containers === true && !('loader' in c) && !('remark' in c));
}

// ── adversarial: a config that throws LAZILY (getter / Proxy trap) must degrade to null, never crash ──
for (const [label, src] of [
	['getter throws', 'ogygia({ content: { markdown: { get containers() { throw 1 } } } })'],
	['themes getter throws', 'ogygia({ content: { markdown: { get themes() { throw 1 } } } })'],
	['transformers getter throws', 'ogygia({ content: { markdown: { code: { get transformers() { throw 1 } } } } })'],
	['content getter throws', 'ogygia({ get content() { throw 1 } })'],
	['proxy throws on any get', 'ogygia({ content: { markdown: new Proxy({}, { get() { throw 1 } }) } })']
]) {
	let threw = false, res;
	try { res = parse_config_markdown(src); } catch { threw = true; }
	ok(`lazy-throw config (${label}) → null, no crash`, !threw && res === null);
}
// prototype pollution attempt doesn't leak to the global Object prototype
{
	const c = parse_config_markdown('ogygia({ content: { markdown: { __proto__: { polluted: 1 }, containers: true } } })');
	ok('prototype pollution attempt is contained', c && c.containers === true && {}.polluted === undefined);
}

console.log(`\n${'─'.repeat(44)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
