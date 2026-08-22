import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
const errs=[]; p.on('pageerror', e=>errs.push('PAGE: '+e.message.slice(0,140)));
p.on('console', m=>{ if(m.type()==='error') errs.push('CERR: '+m.text().slice(0,140)); });
await p.goto('http://localhost:3101/observatory', { waitUntil: 'load' });
for (let i=0;i<30;i++){ await p.waitForTimeout(500); if(await p.evaluate(()=>/real ogygia/.test(document.querySelector('[data-obs-real]')?.textContent||'')).catch(()=>false)) break; }
// switch to islands mode → iframe appears
await p.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find(b=>b.textContent.trim()==='islands')?.click());
await p.waitForTimeout(2500); // iframe loads + harness ready + render
const frameExists = await p.evaluate(()=>!!document.querySelector('[data-obs-frame]'));
console.log('iframe present:', frameExists);
// query INSIDE the iframe
const frame = p.frameLocator('[data-obs-frame]');
const counterText = await frame.locator('#obs-app ogygia-region button').first().textContent().catch(e=>'ERR: '+e.message.slice(0,80));
console.log('counter in iframe:', JSON.stringify(counterText));
// click it (interactive?)
await frame.locator('#obs-app ogygia-region button').first().click().catch(()=>{});
await frame.locator('#obs-app ogygia-region button').first().click().catch(()=>{});
await p.waitForTimeout(200);
const after = await frame.locator('#obs-app ogygia-region button').first().textContent().catch(()=>'ERR');
console.log('after 2 clicks:', JSON.stringify(after));
console.log('errors:', errs.slice(0,5));
await b.close();
