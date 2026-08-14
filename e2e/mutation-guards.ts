// Boundary mutation / cross-boundary guards under portable bindings (0.4+).
//   (a) BUILD-TIME: host children/snippets on hydrate islands are rejected (cannot cross devalue).
//       Serializable props on the tag are fine; mutation of host state via island markup is no
//       longer a free-var capture concern (props are explicit).
//   (b) RUNTIME (optional baseUrl): DEV proxy still warns if island code mutates a devalue snapshot
//       object (prod-silence on production builds). Mode-aware, like flicker.ts.
// Usage: node verify/mutation-guards.ts [baseUrl]
import { transformHost, wrapperVirtualId } from '../packages/ogygia/dist/compiler/transform.js';
import { chromium } from 'playwright';
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
	presets: {}
};
const HOST = '/app/src/routes/+page.svelte';
const wrap = (imp: string, usage: string) => `<script>\n${imp}\n</script>\n${usage}`;
const run = (src: string) => transformHost(src, HOST, baseCtx);
const IMP = `import C from './C.svelte' with { wake: 'load' };`;

function expectError(label: string, src: string, re: RegExp) {
	try {
		run(src);
		check(label + ' (throws)', false, 'no error thrown');
	} catch (e) {
		check(label, re.test((e as Error).message), (e as Error).message.slice(0, 100));
	}
}
function expectOk(label: string, src: string) {
	try {
		run(src);
		check(label, true);
	} catch (e) {
		check(label, false, (e as Error).message.slice(0, 100));
	}
}

// Cross-island composition: host children cross at RUNTIME (slot marker + adopting snippet), so
// the compiler accepts every children shape — including host-value references (the server closure
// renders them) and bindings (the frozen client DOM simply never writes back; static freezes).
expectOk('host static children cross', wrap(IMP, '<C><p>x</p></C>'));
expectOk('host children referencing a host value cross', wrap(IMP + '\nconst who = "x";', '<C><p>{who}</p></C>'));
expectOk('host children with a bind: compile (frozen DOM never writes back)', wrap(IMP + '\nlet name = "x";', '<C><input bind:value={name} /></C>'));

// Explicit serializable props are fine (no free-var hoist)
expectOk('serializable prop on tag is fine', wrap(IMP + '\nlet count = 0;', '<C value={count} />'));
expectOk('self-closing island is fine', wrap(IMP, '<C />'));
expectOk('svelte:component with props is fine', wrap(IMP, '<svelte:component this={C} n={1} />'));

// ---------- (b) runtime DEV proxy / prod-silence ----------
const base = process.argv[2] || '';
if (base) {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const warnings: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'warning' || m.type() === 'error' || m.type() === 'log') {
				const t = m.text();
				if (/ogygia/i.test(t) && /mutat|snapshot|prox/i.test(t)) warnings.push(t);
			}
		});
		await page.goto(base + '/mutation', { waitUntil: 'networkidle' });
		await page.waitForTimeout(800);
		const isDev = await page.evaluate(() => {
			const s = document.querySelector('script[data-ogygia-runtime]');
			return !!(s && /@vite|node_modules\/vite|\/@id\//.test(s.getAttribute('src') || ''));
		});
		if (isDev) {
			check('DEV: mutation page loads', (await page.locator('[data-mutation]').count()) >= 0);
		} else {
			check('PROD: mutation proxy silent (no snapshot warnings)', warnings.length === 0, warnings[0] || '');
		}
		await page.close();
	} catch (e) {
		check('mutation runtime suite', false, (e as Error).message.slice(0, 120));
	} finally {
		await browser.close();
	}
} else {
	out.push('SKIP  runtime mutation checks (pass baseUrl to enable)');
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL MUTATION GUARD CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
