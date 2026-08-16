import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'dark' });
const probe = () => p.evaluate(() => {
  const out = [];
  document.querySelectorAll('.og-body pre').forEach(pre => {
    const acts = pre.querySelectorAll('.og-code-actions');
    const wrap = pre.closest('.code-only');
    const a = acts[0];
    if (!a) { out.push({ id: pre.id?.slice(0,20), acts: 0 }); return; }
    const ar = a.getBoundingClientRect();
    const pr = (wrap ?? pre).getBoundingClientRect();
    const code = pre.querySelector('code');
    const cr = code?.getBoundingClientRect();
    out.push({
      id: pre.id?.slice(0,20),
      acts: acts.length,
      inWrap: !!wrap,
      offsetParent: a.offsetParent?.className?.split(' ')[0],
      barTopInWrap: +(ar.top - pr.top).toFixed(1),
      barH: +ar.height.toFixed(1),
      codeTopInWrap: cr ? +(cr.top - pr.top).toFixed(1) : null,
      overlapsCode: cr ? ar.bottom > cr.top + 1 : null,
      barW: +ar.width.toFixed(0),
    });
  });
  return out.slice(0, 4);
});
// RELOAD state
await p.goto('http://localhost:5174/docs/start/quickstart', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
const reload = await probe();
// SPA NAV state: click a sidebar link
await p.click('.og-cside a[href="/docs/start/install"]');
await p.waitForTimeout(1500);
const nav = await probe();
console.log(JSON.stringify({ reload, nav }, null, 1));
await b.close();
