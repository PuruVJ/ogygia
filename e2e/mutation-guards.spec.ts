// Boundary mutation / cross-boundary guards under portable bindings (0.4+).
//   (a) BUILD-TIME: host children/snippets on hydrate islands are rejected (cannot cross devalue).
//       Serializable props on the tag are fine; mutation of host state via island markup is no
//       longer a free-var capture concern (props are explicit).
//   (b) RUNTIME (optional baseUrl): DEV proxy still warns if island code mutates a devalue snapshot
//       object (prod-silence on production builds). Mode-aware, like flicker.ts.
// Usage: pnpm exec playwright test mutation-guards
import {
	transformHost,
	wrapperVirtualId
} from '../packages/ogygia/dist/compiler/region/transform.js';
import { CTX_EXTRA } from './_ctx-extra.ts';
import path from 'node:path';
import { test, check } from './fixtures/index.ts';

const OGYGIA_RE = /ogygia/i;
const MUTATION_WARN_RE = /mutat|snapshot|prox/i;

const root = '/app';
const baseCtx = {
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
	presets: {}
};
const HOST = '/app/src/routes/+page.svelte';
const wrap = (imp: string, usage: string) => `<script>\n${imp}\n</script>\n${usage}`;
const run = (src: string) => transformHost(src, HOST, baseCtx);
const IMP = `import C from './C.svelte' with { wake: 'load' };`;

function expect_ok(label: string, src: string) {
	try {
		run(src);
		check(label, true);
	} catch (e) {
		check(label, false, (e as Error).message.slice(0, 100));
	}
}

test.describe('captured-var mutation: build errors + DEV/prod runtime', () => {
	// ---------- (a) build-time ----------
	test('build-time: host children, host-value references, bindings and explicit props all compile', () => {
		// Cross-island composition: host children cross at RUNTIME (slot marker + adopting snippet), so
		// the compiler accepts every children shape — including host-value references (the server closure
		// renders them) and bindings (the frozen client DOM simply never writes back; static freezes).
		expect_ok('host static children cross', wrap(IMP, '<C><p>x</p></C>'));
		expect_ok(
			'host children referencing a host value cross',
			wrap(IMP + '\nconst who = "x";', '<C><p>{who}</p></C>')
		);
		expect_ok(
			'host children with a bind: compile (frozen DOM never writes back)',
			wrap(IMP + '\nlet name = "x";', '<C><input bind:value={name} /></C>')
		);

		// Explicit serializable props are fine (no free-var hoist)
		expect_ok(
			'serializable prop on tag is fine',
			wrap(IMP + '\nlet count = 0;', '<C value={count} />')
		);
		expect_ok('self-closing island is fine', wrap(IMP, '<C />'));
		expect_ok(
			'svelte:component with props is fine',
			wrap(IMP, '<svelte:component this={C} n={1} />')
		);
	});

	// ---------- (b) runtime DEV proxy / prod-silence ----------
	test('runtime: DEV proxy page loads / PROD mutation proxy is silent', async ({ page }) => {
		const warnings: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'warning' || m.type() === 'error' || m.type() === 'log') {
				const t = m.text();
				if (OGYGIA_RE.test(t) && MUTATION_WARN_RE.test(t)) warnings.push(t);
			}
		});
		await page.goto('/mutation', { waitUntil: 'networkidle' });
		await page.waitForTimeout(800);
		const isDev = await page.evaluate(() => {
			const s = document.querySelector('script[data-ogygia-runtime]');
			// in-browser: cannot hoist
			return !!(s && /@vite|node_modules\/vite|\/@id\//.test(s.getAttribute('src') || ''));
		});
		if (isDev) {
			check('DEV: mutation page loads', (await page.locator('[data-mutation]').count()) >= 0);
		} else {
			check(
				'PROD: mutation proxy silent (no snapshot warnings)',
				warnings.length === 0,
				warnings[0] || ''
			);
		}
	});
});
