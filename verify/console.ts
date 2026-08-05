// Console cleanliness: zero `hydration_mismatch` warnings across representative pages,
// INCLUDING `/lakes` (the lake lift/restore path must seed empty Boundary+Placeholder anchors
// so Svelte does not warn).
//
//   node verify/console.ts http://localhost:3051          # prod/preview
//   node verify/console.ts http://localhost:5173          # vite dev (warnings are DEV-noisy;
//                                                         # hydration_mismatch is DEV-only)
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';
const pages = [
	'/',
	'/about',
	'/data',
	'/static',
	'/plain',
	'/kit',
	'/dashboard/orders',
	'/dashboard/orders/3',
	'/dashboard/analytics',
	'/dashboard/settings',
	'/lakes'
];

const browser = await chromium.launch();
const page = await browser.newPage();
let total = 0;
for (const p of pages) {
	const hits = [];
	const handler = (msg) => {
		if (msg.text().includes('hydration_mismatch')) hits.push(msg.text().slice(0, 80));
	};
	page.on('console', handler);
	await page.goto(base + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
	await page.waitForTimeout(1200);
	page.off('console', handler);
	console.log(`${hits.length === 0 ? 'CLEAN' : 'DIRTY'}  ${p}  (${hits.length})`);
	if (hits.length) for (const h of hits) console.log('   ', h);
	total += hits.length;
}
console.log(total === 0 ? '\nZERO hydration_mismatch warnings across all pages' : `\n${total} warnings remain`);
await browser.close();
process.exit(total === 0 ? 0 : 1);
