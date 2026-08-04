// Captured-var mutation guards (task 1).
//   (a) BUILD-TIME: the transform's free-var analysis errors when island MARKUP writes to a captured
//       host variable (assignment / update / compound / destructuring-assignment / bind:). Runs the
//       built transform directly — no server needed.
//   (b) RUNTIME (DEV): a deep Proxy around the devalue-parsed props warns once per path when the
//       island COMPONENT mutates a captured snapshot (object property, Map/Set mutators). In PROD the
//       prop is the plain object, so it is SILENT (prod-silence). Mode-aware, like flicker.ts.
// Usage: node verify/mutation-guards.ts [baseUrl]
import { transformHost } from '../packages/ogygia/dist/vite/transform.js';
import { chromium } from 'playwright';
import path from 'node:path';

let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

// ---------- (a) build-time errors ----------
const root = '/app';
const baseCtx = {
	root,
	libDir: '/app/src/lib',
	readFile: () => null,
	pathModule: path,
	dev: false,
	virtualPathFor: (hostId: string, iid: string) => path.join(path.dirname(hostId), '.ogygia', iid + '.svelte'),
	devUrlFor: (p: string) => '/' + path.relative(root, p),
	visibleMargin: '0px',
	presets: {}
};
const HOST = '/app/src/routes/+page.svelte';
const wrap = (imp: string, usage: string) => `<script>\n${imp}\n</script>\n${usage}`;
const run = (src: string) => transformHost(src, HOST, baseCtx);
const IMP = `import C from './C.svelte' with { hydrate: 'load' };`;

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

expectError('assignment to captured var errors', wrap(IMP + '\nlet count = 0;', '<C onclick={() => count = 1} />'), /mutates captured host variable `count`.*serialized snapshot/s);
expectError('update (++) on captured var errors', wrap(IMP + '\nlet count = 0;', '<C onclick={() => count++} />'), /captured host variable `count`/);
expectError('compound (+=) on captured var errors', wrap(IMP + '\nlet count = 0;', '<C onclick={() => count += 2} />'), /captured host variable `count`/);
expectError('member write on captured object errors', wrap(IMP + '\nlet obj = { a: 1 };', '<C onclick={() => obj.a = 9} />'), /captured host variable `obj`/);
expectError('destructuring-assignment to captured vars errors', wrap(IMP + '\nlet a = 1, b = 2;', '<C onclick={() => ([a, b] = [b, a])} />'), /captured host variable `[ab]`/);
expectError('object destructuring-assignment to captured var errors', wrap(IMP + '\nlet a = 1;', '<C onclick={() => ({ a } = { a: 5 })} />'), /captured host variable `a`/);
expectError('bind: to captured var errors', wrap(IMP + '\nlet name = "x";', '<C><input bind:value={name} /></C>'), /captured host variable `name`/);
expectError('error names the file', wrap(IMP + '\nlet count = 0;', '<C onclick={() => count++} />'), /src\/routes\/\+page\.svelte/);
expectError('error states the fix (move state inside the island)', wrap(IMP + '\nlet count = 0;', '<C onclick={() => count++} />'), /move mutable state inside the island/i);

// negatives: legitimate writes are NOT flagged
expectOk('mutating a handler-local var is fine', wrap(IMP, '<C onclick={() => { let x = 0; x++; }} />'));
expectOk('mutating an each-local is fine', wrap(IMP + '\nlet items = [1];', '<C>{#each items as it}<button onclick={() => it++}>x</button>{/each}</C>'));
expectOk('writing a global (location) is not a captured mutation', wrap(IMP, '<C onclick={() => location.href = "/x"} />'));
expectOk('reading a captured var is fine', wrap(IMP + '\nlet count = 0;', '<C value={count} />'));

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
				if (t.includes('mutating captured host snapshot')) warnings.push(t);
			}
		});
		await page.goto(base + '/mutation', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-mutation-done]', { timeout: 6000 }).catch(() => {});
		// wait until the island's onMount has run its mutations
		await page.waitForFunction(
			() => document.querySelector('[data-mutation-done]')?.textContent?.includes('mutated'),
			{ timeout: 6000 }
		).catch(() => {});
		await new Promise((r) => setTimeout(r, 600));

		// Detect mode from the runtime <script src>: prod ships a content-hashed filename.
		const runtimeSrc = await page.$$eval('script[src]', (els) =>
			(els as HTMLScriptElement[]).map((e) => e.src).find((s) => s.includes('ogygia-runtime')) || ''
		);
		const isProd = /ogygia-runtime\.[0-9a-f]{12}\.js/.test(runtimeSrc);
		out.push(`INFO  runtime = ${runtimeSrc || '(inline/dev)'} -> ${isProd ? 'PROD' : 'DEV'}`);

		// the mutations are no-ops either way: the rendered count reflects the local read, but the
		// HOST snapshot never changes (there is no host re-render to observe). The island DID run.
		check('island ran its onMount mutations', await page.locator('[data-mutation-done]').textContent().then((t) => (t || '').includes('mutated')));

		if (isProd) {
			check('PROD-SILENCE: no captured-snapshot mutation warnings', warnings.length === 0, warnings.slice(0, 2).join(' | '));
		} else {
			check('DEV: object-property mutation warns (config.count)', warnings.some((w) => /'config\.count'/.test(w)), warnings.slice(0, 3).join(' | '));
			check('DEV: Map mutator warns (config.meta.set())', warnings.some((w) => /'config\.meta\.set\(\)'/.test(w)), warnings.slice(0, 3).join(' | '));
			check('DEV: Set mutator warns (config.roles.add())', warnings.some((w) => /'config\.roles\.add\(\)'/.test(w)), warnings.slice(0, 3).join(' | '));
			check('DEV: warning states the contract', warnings.some((w) => /move mutable state inside the island/i.test(w)));
		}
		await page.close();
	} finally {
		await browser.close();
	}
} else {
	out.push('INFO  no baseUrl given — ran build-time checks only (pass a URL to also check the DEV proxy)');
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL MUTATION-GUARD CHECKS PASSED' : failures + ' MUTATION-GUARD CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
