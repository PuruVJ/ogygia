import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:4173';
const pages = ['/', '/about', '/data', '/dashboard', '/lakes', '/forms'];
const browser = await chromium.launch();
for (const p of pages) {
  const page = await browser.newPage();
  const msgs = [];
  page.on('console', (m) => msgs.push(m.type()+': '+m.text()));
  await page.goto(base + p, { waitUntil: 'networkidle' }).catch(()=>{});
  await new Promise(r=>setTimeout(r,600));
  const mism = msgs.filter(m => /hydration_mismatch|hydration failed|was not expected|did not match/i.test(m));
  console.log(`\n=== ${p} ===  (${mism.length} mismatch msgs)`);
  for (const m of mism) console.log('  '+m.slice(0,180));
  await page.close();
}
await browser.close();
