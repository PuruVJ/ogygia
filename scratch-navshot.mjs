import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 950 }});
await p.goto('http://localhost:3101/observatory', { waitUntil: 'load' });
for (let i=0;i<30;i++){ await p.waitForTimeout(500); if(await p.evaluate(()=>/real ogygia/.test(document.querySelector('[data-obs-real]')?.textContent||'')).catch(()=>false)) break; }
await p.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find(b=>b.textContent==='keep · nav')?.click());
await p.waitForTimeout(900);
await p.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find(b=>b.textContent.trim()==='islands')?.click());
await p.waitForTimeout(1200);
for (let i=0;i<3;i++){ await p.click('[data-obs-preview] ogygia-region[data-ogygia-keep] button').catch(()=>{}); await p.waitForTimeout(70); }
await p.click('[data-obs-preview] a[data-obs-nav="About.svelte"]').catch(()=>{});
await p.waitForTimeout(1200);
const box = await p.locator('[data-observatory]').boundingBox();
await p.screenshot({ path: '/tmp/obs-nav.png', clip: {x:box.x,y:box.y,width:box.width,height:Math.min(box.height,520)} });
console.log('saved');
await b.close();
