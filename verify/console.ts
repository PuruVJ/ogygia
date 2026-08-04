import { createRequire } from 'node:module';
const { chromium } = createRequire('/Users/puruvj/Projects/sk-islands/verify/x.js')('playwright');
const base = process.argv[2] ?? 'http://localhost:4173';
const pages = ['/', '/about', '/data', '/static', '/plain', '/kit', '/dashboard/orders', '/dashboard/orders/3', '/dashboard/analytics', '/dashboard/settings'];
const browser = await chromium.launch();
const page = await browser.newPage();
let total = 0;
for (const p of pages) {
  const hits = [];
  const handler = (msg) => { if (msg.text().includes('hydration_mismatch')) hits.push(msg.text().slice(0, 60)); };
  page.on('console', handler);
  await page.goto(base + p, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  page.off('console', handler);
  console.log(`${hits.length === 0 ? 'CLEAN' : 'DIRTY'}  ${p}  (${hits.length})`);
  total += hits.length;
}
console.log(total === 0 ? '\nZERO hydration_mismatch warnings across all pages' : `\n${total} warnings remain`);
await browser.close();
process.exit(total === 0 ? 0 : 1);
