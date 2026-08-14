import { describe, expect, it } from 'vitest';
import { transform_tabs, has_tabs } from '../src/content/markdown/tabs.js';

/** Backtick fence helper — keeps the test source readable (no escaping a wall of backticks). */
const F = '```';
const F4 = '````';
const TILDE = '~~~';

/** Run the transform and return just the code. */
const run = (src: string) => transform_tabs(src).code;
/** Collect the `<Tab label="...">` labels in emitted order. */
const labels = (src: string) => [...run(src).matchAll(/<Tab label="([^"]*)">/g)].map((m) => m[1]);
/** The `group` attribute of the first emitted `<TabGroup>`. */
const group = (src: string) => run(src).match(/<TabGroup group="([^"]*)">/)?.[1];
/** Every emitted group attribute, in order. */
const groups = (src: string) => [...run(src).matchAll(/<TabGroup group="([^"]*)">/g)].map((m) => m[1]);
/** True when every ``` / ~~~ fence in the emitted code is balanced (even count of run-starts). */
const fences_balanced = (code: string) => {
	let bt = 0;
	let ti = 0;
	for (const line of code.split('\n')) {
		if (/^\s*`{3,}/.test(line)) bt++;
		else if (/^\s*~{3,}/.test(line)) ti++;
	}
	return bt % 2 === 0 && ti % 2 === 0;
};

describe('has_tabs gate', () => {
	it('detects code-group and tabs openers', () => {
		expect(has_tabs('::: code-group')).toBe(true);
		expect(has_tabs('::: tabs')).toBe(true);
		expect(has_tabs('  ::: tabs foo')).toBe(true);
		expect(has_tabs('text\n::: code-group\n')).toBe(true);
	});
	it('ignores unrelated content', () => {
		expect(has_tabs('just prose')).toBe(false);
		expect(has_tabs('::: tip\nhi\n:::')).toBe(false);
		expect(has_tabs('the word tabs and code-group in prose')).toBe(false);
	});
	it('does not fire the pass when absent (identity + used=false)', () => {
		const src = 'no tabs here\n\n## Heading\n';
		const r = transform_tabs(src);
		expect(r.used).toBe(false);
		expect(r.code).toBe(src);
	});
});

describe('code-group — basics', () => {
	const src = [
		'::: code-group',
		`${F}bash [npm]`,
		'npm i ogygia',
		F,
		`${F}bash [pnpm]`,
		'pnpm add ogygia',
		F,
		':::'
	].join('\n');

	it('marks used', () => {
		expect(transform_tabs(src).used).toBe(true);
	});
	it('emits one Tab per fence, labelled from [label]', () => {
		expect(labels(src)).toEqual(['npm', 'pnpm']);
	});
	it('strips the [label] from the fence but keeps the language', () => {
		const code = run(src);
		expect(code).toContain(`${F}bash`);
		expect(code).not.toContain('[npm]');
		expect(code).not.toContain('[pnpm]');
	});
	it('keeps the code content', () => {
		expect(run(src)).toContain('npm i ogygia');
		expect(run(src)).toContain('pnpm add ogygia');
	});
	it('wraps in a single <TabGroup>…</TabGroup>', () => {
		const code = run(src);
		expect(code.match(/<TabGroup /g)).toHaveLength(1);
		expect(code.match(/<\/TabGroup>/g)).toHaveLength(1);
	});
});

describe('code-group — labels & languages', () => {
	it('falls back to "Tab N" when a fence has no [label]', () => {
		const src = [`::: code-group`, `${F}js`, 'a', F, `${F}ts`, 'b', F, ':::'].join('\n');
		expect(labels(src)).toEqual(['Tab 1', 'Tab 2']);
	});
	it('handles [label] before OR after the language', () => {
		const a = [`::: code-group`, `${F}js [First]`, 'x', F, ':::'].join('\n');
		const b = [`::: code-group`, `${F}[Second] js`, 'y', F, ':::'].join('\n');
		expect(labels(a)).toEqual(['First']);
		expect(run(a)).toContain(`${F}js`);
		expect(labels(b)).toEqual(['Second']);
		expect(run(b)).toContain(`${F}js`);
	});
	it('handles a fence with only a [label] and no language', () => {
		const src = [`::: code-group`, `${F} [Plain]`, 'x', F, ':::'].join('\n');
		expect(labels(src)).toEqual(['Plain']);
	});
	it('supports labels with spaces', () => {
		const src = [`::: code-group`, `${F}bash [Package manager]`, 'x', F, ':::'].join('\n');
		expect(labels(src)).toEqual(['Package manager']);
	});
});

describe('code-group — grouping / sync', () => {
	it('defaults to a label-set key so identical sets sync', () => {
		const src = [`::: code-group`, `${F}b [npm]`, 'x', F, `${F}b [pnpm]`, 'y', F, ':::'].join('\n');
		expect(group(src)).toBe('cg:npm~pnpm');
	});
	it('honours an explicit group name on the opener', () => {
		const src = [`::: code-group pm`, `${F}b [npm]`, 'x', F, ':::'].join('\n');
		expect(group(src)).toBe('pm');
	});
	it('two blocks with the same labels get the same auto group', () => {
		const block = [`::: code-group`, `${F}b [npm]`, 'x', F, `${F}b [pnpm]`, 'y', F, ':::'].join('\n');
		const src = `${block}\n\n${block}`;
		const groups = [...run(src).matchAll(/<TabGroup group="([^"]*)">/g)].map((m) => m[1]);
		expect(groups).toEqual(['cg:npm~pnpm', 'cg:npm~pnpm']);
	});
});

describe('code-group — fence robustness', () => {
	it('supports tilde fences', () => {
		const src = [`::: code-group`, `${TILDE}bash [npm]`, 'x', TILDE, ':::'].join('\n');
		expect(labels(src)).toEqual(['npm']);
	});
	it('respects fence length — a ``` inside a ```` block is content, not a close', () => {
		const src = [
			'::: code-group',
			`${F4}md [Doc]`,
			'Here is a nested fence:',
			`${F}js`,
			'const x = 1;',
			F,
			F4,
			':::'
		].join('\n');
		// ONE tab, and the inner ``` survived as content.
		expect(labels(src)).toEqual(['Doc']);
		expect(run(src)).toContain('const x = 1;');
		expect(run(src)).toContain(`${F}js`);
	});
	it('tolerates an unclosed fence (runs to block end)', () => {
		const src = [`::: code-group`, `${F}bash [npm]`, 'npm i', ':::'].join('\n');
		expect(transform_tabs(src).used).toBe(true);
		expect(labels(src)).toEqual(['npm']);
	});
	it('ignores stray non-fence lines between blocks', () => {
		const src = [`::: code-group`, 'stray text', `${F}b [npm]`, 'x', F, ':::'].join('\n');
		expect(labels(src)).toEqual(['npm']);
		expect(run(src)).not.toContain('stray text');
	});
});

describe('tabs — basics', () => {
	const src = ['::: tabs', '== macOS', 'brew install node', '== Linux', 'apt install node', ':::'].join('\n');
	it('emits one Tab per == marker', () => {
		expect(labels(src)).toEqual(['macOS', 'Linux']);
	});
	it('keeps each tab body', () => {
		expect(run(src)).toContain('brew install node');
		expect(run(src)).toContain('apt install node');
	});
	it('drops content before the first == marker', () => {
		const s = ['::: tabs', 'preamble', '== A', 'body', ':::'].join('\n');
		expect(run(s)).not.toContain('preamble');
		expect(labels(s)).toEqual(['A']);
	});
});

describe('tabs — grouping', () => {
	it('auto-numbers independent groups per block', () => {
		const b = ['::: tabs', '== A', 'x', '== B', 'y', ':::'].join('\n');
		const src = `${b}\n\n${b}`;
		const groups = [...run(src).matchAll(/<TabGroup group="([^"]*)">/g)].map((m) => m[1]);
		expect(groups).toEqual(['tabs0', 'tabs1']);
	});
	it('honours an explicit group name', () => {
		const src = ['::: tabs install', '== A', 'x', ':::'].join('\n');
		expect(group(src)).toBe('install');
	});
});

describe('tabs — fence robustness', () => {
	it('a "== ..." line inside a code fence is NOT a tab marker', () => {
		const src = [
			'::: tabs',
			'== Config',
			`${F}ini`,
			'== section',
			'key = value',
			F,
			'== Other',
			'text',
			':::'
		].join('\n');
		// Two tabs: "Config" and "Other". The fenced "== section" is content.
		expect(labels(src)).toEqual(['Config', 'Other']);
		expect(run(src)).toContain('== section');
	});
	it('a ":::" inside a code fence does NOT close the block early', () => {
		const src = [
			'::: tabs',
			'== Sample',
			`${F}md`,
			'::: tip',
			'nested',
			':::',
			F,
			'== Next',
			'ok',
			':::'
		].join('\n');
		expect(labels(src)).toEqual(['Sample', 'Next']);
		expect(run(src)).toContain('::: tip');
	});
});

describe('top-level fences are never touched', () => {
	it('ignores a ::: code-group written inside a top-level fence', () => {
		const src = [`${F}md`, '::: code-group', `${F}bash [npm]`, 'x', F, ':::', F].join('\n');
		const r = transform_tabs(src);
		expect(r.used).toBe(false);
		expect(r.code).toBe(src);
	});
	it('ignores ::: tabs inside a ```` block that contains ``` runs', () => {
		const src = [`${F4}md`, '::: tabs', '== A', F, 'inner', F, 'x', ':::', F4].join('\n');
		expect(transform_tabs(src).used).toBe(false);
	});
});

describe('escaping', () => {
	it('escapes special characters in labels', () => {
		const src = [`::: code-group`, `${F}b [a"b<c>&d]`, 'x', F, ':::'].join('\n');
		const code = run(src);
		expect(code).toContain('&quot;');
		expect(code).toContain('&lt;');
		expect(code).toContain('&gt;');
		expect(code).toContain('&amp;');
		expect(code).not.toMatch(/label="a"b/); // the raw quote must not break the attribute
	});
});

describe('multiple & mixed blocks', () => {
	it('transforms several blocks in one document', () => {
		const src = [
			'intro',
			'::: code-group',
			`${F}b [npm]`,
			'x',
			F,
			':::',
			'middle',
			'::: tabs',
			'== A',
			'y',
			':::',
			'end'
		].join('\n');
		const code = run(src);
		expect(code.match(/<TabGroup /g)).toHaveLength(2);
		expect(code).toContain('intro');
		expect(code).toContain('middle');
		expect(code).toContain('end');
		expect(labels(src)).toEqual(['npm', 'A']);
	});
});

describe('malformed / edge cases (never throws, always valid)', () => {
	it('an empty code-group emits nothing and is not "used"', () => {
		const src = ['::: code-group', ':::'].join('\n');
		const r = transform_tabs(src);
		expect(r.used).toBe(false);
		expect(r.code).not.toContain('<TabGroup');
	});
	it('an empty tabs block emits nothing', () => {
		const src = ['::: tabs', ':::'].join('\n');
		expect(transform_tabs(src).used).toBe(false);
	});
	it('tolerates an unclosed block (runs to EOF)', () => {
		const src = ['::: tabs', '== A', 'body without a closing marker'].join('\n');
		expect(transform_tabs(src).used).toBe(true);
		expect(labels(src)).toEqual(['A']);
	});
	it('handles indented openers and markers', () => {
		const src = ['  ::: tabs', '  == A', '  body', '  :::'].join('\n');
		expect(labels(src)).toEqual(['A']);
	});
	it('tolerates extra whitespace around ::: and ==', () => {
		const src = [':::   code-group', `${F}b [npm]`, 'x', F, ':::  '].join('\n');
		expect(labels(src)).toEqual(['npm']);
	});
	it('does not treat "==" with no space as a marker', () => {
		const src = ['::: tabs', '==NoSpace', '== Real', 'x', ':::'].join('\n');
		expect(labels(src)).toEqual(['Real']);
	});
	it('is a no-op on empty input', () => {
		expect(transform_tabs('')).toEqual({ code: '', used: false });
	});
	it('never throws on adversarial fence/marker soup', () => {
		const src = [
			'::: code-group',
			`${F4}`,
			'::: tabs',
			'== x',
			F,
			'::: code-group',
			`${TILDE}`,
			':::'
		].join('\n');
		expect(() => transform_tabs(src)).not.toThrow();
	});
	it('never throws on a wall of bare fences and markers', () => {
		const src = [
			F,
			TILDE,
			'::: tabs',
			'==',
			'== ',
			'==x',
			`${F4}[a]`,
			':::',
			F,
			'::: code-group',
			`${F}[Only]`,
			F,
			TILDE,
			F4
		].join('\n');
		expect(() => transform_tabs(src)).not.toThrow();
	});
	it('never throws on a lone opener with nothing after it', () => {
		expect(() => transform_tabs('::: code-group')).not.toThrow();
		expect(() => transform_tabs('::: tabs')).not.toThrow();
		expect(() => transform_tabs('  ::: tabs name')).not.toThrow();
	});
	it('never throws on only-whitespace or newline noise', () => {
		expect(() => transform_tabs('\n\n\n')).not.toThrow();
		expect(() => transform_tabs('   \n\t\n')).not.toThrow();
	});
});

describe('has_tabs — prose false positives stay false', () => {
	it('does not fire on prose mentioning the feature names', () => {
		expect(has_tabs('you gain the ability to import a code-group helper')).toBe(false);
		expect(has_tabs('tabs vs spaces is an eternal debate')).toBe(false);
		expect(has_tabs('see :::tip for admonitions')).toBe(false); // no keyword
		expect(has_tabs('::: warning\nnot a tab group\n:::')).toBe(false);
	});
	it('fires on a real opener even when buried mid-document', () => {
		expect(has_tabs('# Title\n\nintro\n\n::: code-group\n')).toBe(true);
		expect(has_tabs('a\nb\n\t::: tabs custom\n')).toBe(true);
	});
	it('fires on a CRLF-terminated opener', () => {
		expect(has_tabs('lead\r\n::: tabs\r\n')).toBe(true);
	});
});

describe('CRLF line endings', () => {
	it('parses a code-group written with CRLF', () => {
		const src = ['::: code-group', `${F}bash [npm]`, 'npm i ogygia', F, ':::'].join('\r\n');
		expect(transform_tabs(src).used).toBe(true);
		expect(labels(src)).toEqual(['npm']);
		expect(run(src)).toContain('npm i ogygia');
	});
	it('parses == markers written with CRLF', () => {
		const src = ['::: tabs', '== macOS', 'brew', '== Linux', 'apt', ':::'].join('\r\n');
		expect(labels(src)).toEqual(['macOS', 'Linux']);
	});
	it('is fence-aware under CRLF (a fenced == is content)', () => {
		const src = ['::: tabs', '== A', `${F}sh`, '== not a marker', F, '== B', 'x', ':::'].join('\r\n');
		expect(labels(src)).toEqual(['A', 'B']);
		expect(run(src)).toContain('== not a marker');
	});
	it('normalizes emitted output to LF (no stray carriage returns)', () => {
		const src = ['::: tabs', '== A', 'x', ':::'].join('\r\n');
		expect(run(src)).not.toContain('\r');
	});
	it('handles a lone-CR document', () => {
		const src = ['::: code-group', `${F}js [only]`, 'a', F, ':::'].join('\r');
		expect(labels(src)).toEqual(['only']);
	});
});

describe('well-formed output', () => {
	it('emits balanced fences for a normal code-group', () => {
		const src = [`::: code-group`, `${F}b [npm]`, 'x', F, `${F}b [pnpm]`, 'y', F, ':::'].join('\n');
		expect(fences_balanced(run(src))).toBe(true);
	});
	it('synthesizes a closer for an unclosed code-group fence', () => {
		const src = [`::: code-group`, `${F}bash [npm]`, 'npm i', ':::'].join('\n');
		const code = run(src);
		expect(labels(src)).toEqual(['npm']);
		expect(fences_balanced(code)).toBe(true);
	});
	it('synthesizes a closer for an unclosed fence inside a tabs body', () => {
		const src = ['::: tabs', '== A', `${F}sh`, 'echo hi', ':::'].join('\n');
		const code = run(src);
		expect(labels(src)).toEqual(['A']);
		expect(fences_balanced(code)).toBe(true);
	});
	it('wraps each tab in exactly one <Tab>…</Tab>', () => {
		const src = ['::: tabs', '== A', 'x', '== B', 'y', ':::'].join('\n');
		const code = run(src);
		expect(code.match(/<Tab /g)).toHaveLength(2);
		expect(code.match(/<\/Tab>/g)).toHaveLength(2);
	});
});

describe('grouping — cross-block sync & isolation', () => {
	it('different label sets get different code-group keys', () => {
		const a = [`::: code-group`, `${F}b [npm]`, 'x', F, `${F}b [pnpm]`, 'y', F, ':::'].join('\n');
		const b = [`::: code-group`, `${F}b [deno]`, 'z', F, ':::'].join('\n');
		expect(groups(`${a}\n\n${b}`)).toEqual(['cg:npm~pnpm', 'cg:deno']);
	});
	it('an explicit name overrides the label-set key', () => {
		const src = [`::: code-group shared`, `${F}b [npm]`, 'x', F, ':::'].join('\n');
		expect(group(src)).toBe('shared');
	});
	it('tabs blocks keep independent auto groups even when interleaved with code-groups', () => {
		const t = ['::: tabs', '== A', 'x', ':::'].join('\n');
		const c = [`::: code-group`, `${F}b [npm]`, 'y', F, ':::'].join('\n');
		expect(groups(`${t}\n\n${c}\n\n${t}`)).toEqual(['tabs0', 'cg:npm', 'tabs1']);
	});
});

describe('mixed real-world document', () => {
	const src = [
		'# Install',
		'',
		'Pick your manager:',
		'',
		'::: code-group',
		`${F}bash [npm]`,
		'npm i ogygia',
		F,
		`${F}bash [pnpm]`,
		'pnpm add ogygia',
		F,
		':::',
		'',
		'Then configure:',
		'',
		'::: tabs config',
		'== Vite',
		'Edit `vite.config.ts`.',
		'== Svelte',
		'Edit `svelte.config.js`.',
		':::',
		'',
		'Here is untouched prose with a fenced sample:',
		'',
		`${F4}md`,
		'::: code-group',
		`${F}sh [should stay]`,
		'echo hi',
		F,
		':::',
		F4,
		'',
		'Done.'
	].join('\n');

	it('transforms exactly the two real blocks', () => {
		const code = run(src);
		expect(code.match(/<TabGroup /g)).toHaveLength(2);
	});
	it('collects labels across both blocks in order', () => {
		expect(labels(src)).toEqual(['npm', 'pnpm', 'Vite', 'Svelte']);
	});
	it('uses the label-set key and the explicit name respectively', () => {
		expect(groups(src)).toEqual(['cg:npm~pnpm', 'config']);
	});
	it('leaves the fenced code sample untouched', () => {
		const code = run(src);
		expect(code).toContain('[should stay]');
		expect(code).toContain('echo hi');
	});
	it('preserves surrounding prose', () => {
		const code = run(src);
		expect(code).toContain('# Install');
		expect(code).toContain('Pick your manager:');
		expect(code).toContain('Done.');
	});
	it('produces balanced fences overall', () => {
		expect(fences_balanced(run(src))).toBe(true);
	});
	it('never throws on the whole document', () => {
		expect(() => transform_tabs(src)).not.toThrow();
	});
});
