// PAGE-CSR invariant, browser truth — a REAL build of internal/repro-deep-csr, the consumer
// shape that regressed: the root layout declares NO csr anywhere in its own chain; the ONLY
// `csr = false` lives in a deep catch-all (+ one explicit csr=true page → the layout's world is
// MIXED). The root chrome (Header counter island + headless Boot island) must:
//   · on /content/* (csr=false): render as real <ogygia-region>s and HYDRATE (the regression
//     stripped them to plain while Kit shipped no client — dead chrome);
//   · on /spa (csr=true): degrade to Kit-owned inline components, still interactive.
// Self-contained: builds the fixture app, boots its adapter-node output, checks, tears down.
// Usage: node e2e/deep-csr.ts
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = join(repo, 'internal', 'repro-deep-csr');
const PORT = 3071;
const base = `http://localhost:${PORT}`;

let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ── 1. build the fixture (its vite build consumes the live workspace ogygia) ────────────────
const built = spawnSync('pnpm', ['--dir', dir, 'build'], { stdio: 'inherit' });
if (built.status !== 0) {
	console.error('\x1b[31m✗ repro-deep-csr build failed\x1b[0m');
	process.exit(1);
}

// ── 2. boot the adapter-node output ─────────────────────────────────────────────────────────
const srv = spawn('node', ['build/index.js'], {
	cwd: dir,
	env: { ...process.env, PORT: String(PORT), ORIGIN: base },
	stdio: 'ignore'
});
let up = false;
for (let i = 0; i < 80 && !up; i++) {
	try {
		up = (await fetch(base + '/spa')).ok;
	} catch {
		await new Promise((r) => setTimeout(r, 250));
	}
}
if (!up) {
	console.error('\x1b[31m✗ repro-deep-csr server never came up\x1b[0m');
	srv.kill();
	process.exit(1);
}

try {
	// ── SSR: the csr=false world ──────────────────────────────────────────────────────────────
	const content = await (await fetch(base + '/content/hello')).text();
	check('SSR /content: page rendered', /data-page="content"/.test(content));
	check(
		'SSR /content: Header chrome is a REAL region (not stripped — the regression)',
		/<ogygia-region[\s\S]*?data-chrome-header/.test(content)
	);
	check(
		'SSR /content: headless Boot island region present',
		(content.match(/<ogygia-region/g) || []).length >= 2,
		`regions=${(content.match(/<ogygia-region/g) || []).length}`
	);
	check('SSR /content: Kit is NOT booted (csr=false)', !/__sveltekit_/.test(content));

	// ── SSR: the csr=true world ───────────────────────────────────────────────────────────────
	const spa = await (await fetch(base + '/spa')).text();
	check('SSR /spa: page rendered', /data-page="spa"/.test(spa));
	check('SSR /spa: Kit IS booted (csr=true)', /__sveltekit_/.test(spa));

	// ── Browser: chrome hydrates on the csr=false page ────────────────────────────────────────
	const browser = await chromium.launch();
	try {
		for (const [route, label] of [
			['/content/hello', 'csr=false page (ogygia hydrates the chrome)'],
			['/spa', 'csr=true page (Kit hydrates the chrome inline)']
		] as const) {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			page.on('console', (m) => {
				if (m.type() === 'error') errors.push('console: ' + m.text());
			});
			await page.goto(base + route, { waitUntil: 'networkidle' });
			await page.waitForTimeout(300);

			const count = page.locator('[data-header-count]');
			check(`${label}: header seeded (0)`, (await count.innerText()) === '0');
			await count.click();
			await page.waitForTimeout(60);
			check(
				`${label}: header ALIVE (0 → 1)`,
				(await count.innerText()) === '1',
				`n=${await count.innerText()}`
			);
			check(
				`${label}: boot island effect ran`,
				(await page.evaluate(() => document.documentElement.dataset.boot)) === 'on'
			);
			check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
			await page.close();
		}
	} finally {
		await browser.close();
	}
} finally {
	srv.kill();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} deep-csr check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL DEEP-CSR CHECKS PASSED\x1b[0m');
