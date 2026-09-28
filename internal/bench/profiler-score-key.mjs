// THE PAGE SCORE'S ANSWER KEY: the playground's score-lab twins carry the same article and the same
// code editor. /score-lab ships it as a lazy island (csr=false); /score-lab-kit ships it the usual
// fully hydrated way (csr=true, no islands). The profiler must weigh the fully hydrated twin's whole
// start graph (the editor's chunk included — no islands is not "0 JS") and rank it well below.
//
// Against a preview you started (a build: the dev server serves modules one by one):
//   cd apps/playground && pnpm build
//   OGYGIA_PROFILER_SECRET=hell ORIGIN=http://127.0.0.1:4181 node node_modules/vite/bin/vite.js preview --port 4181
//   node internal/bench/profiler-score-key.mjs [base=http://127.0.0.1:4181] [key=hell]
// Exit code 1 on a failure.
import { createRequire } from 'node:module';

const [base = 'http://127.0.0.1:4181', key = 'hell'] = process.argv.slice(2);

async function profile(page) {
	const r = await fetch(`${base}/__profiler/page?p=${encodeURIComponent(page)}&runs=3&format=json`, { headers: { 'x-profiler-key': key } });
	if (!r.ok) throw new Error(`${page}: the profiler answered ${r.status}`);
	return r.json();
}

const checks = [];
const check = (name, ok, extra = '') => {
	checks.push(ok);
	console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const islands = await profile('/score-lab');
const kit = await profile('/score-lab-kit');
const cat = (r, k) => r.score?.categories?.find((c) => c.key === k);
const kb = (n) => `${Math.round(n / 1024)} KB`;

console.log(`/score-lab      ${islands.score.score} ${islands.score.grade} · JS ${kb(islands.assets.totals.js)} at start, ${kb(islands.assets.totals.lazy_js)} lazy`);
console.log(`/score-lab-kit  ${kit.score.score} ${kit.score.grade} · JS ${kb(kit.assets.totals.js)} at start`);

check('both twins were weighed (no "0 JS")', !!islands.assets?.totals && !!kit.assets?.totals && kit.assets.totals.js > 0);
check('the fully hydrated twin counts the editor\'s code at start (its route node followed)', kit.assets.totals.js > 400 * 1024, kb(kit.assets.totals.js));
check('the islands twin keeps the editor\'s code lazy', islands.assets.totals.lazy_js > 300 * 1024 && islands.assets.totals.js < 120 * 1024, `${kb(islands.assets.totals.js)} at start, ${kb(islands.assets.totals.lazy_js)} lazy`);
check('the islands twin scores well above its fully hydrated twin', islands.score.score >= kit.score.score + 12, `${islands.score.score} vs ${kit.score.score}`);
check('JS is what costs the fully hydrated twin most', kit.score.worst?.key === 'js', kit.score.worst?.key);
check('no hydration category on a page with no islands (never a free 100)', !cat(kit, 'hydration'));
check('the biggest file is named', (cat(kit, 'js')?.detail ?? []).some((d) => d.includes('KB')), (cat(kit, 'js')?.detail ?? []).join(', '));

// ── PHASE 2: a real browser visit to each (the profiler's own visit: the key header), so the
// score gets the vitals, the long tasks and hydration — then the same reports are read again
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const browser = await chromium.launch();
for (const page of ['/score-lab', '/score-lab-kit']) {
	const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-profiler-key': key }, viewport: { width: 1280, height: 800 } });
	const p = await ctx.newPage();
	await p.goto(base + page, { waitUntil: 'load' });
	await p.mouse.wheel(0, 2000); // the islands twin's editor wakes on sight
	await p.waitForTimeout(1500);
	await p.locator('[data-score-editor]').click().catch(() => {}); // an interaction for INP
	await p.waitForTimeout(8000); // the CPU trace closes 8 s in
	await p.goto('about:blank'); // the page hides: the vitals and the final visit go out
	await p.waitForTimeout(800);
	await ctx.close();
}
await browser.close();
const reread = async (r) => (await fetch(`${base}/__profiler/report/${r.id}.json`, { headers: { 'x-profiler-key': key } })).json();
const islands2 = await reread(islands);
const kit2 = await reread(kit);
for (const [name, r] of [['/score-lab', islands2], ['/score-lab-kit', kit2]])
	console.log(`${name.padEnd(15)} ${r.score.score} ${r.score.grade} · ${r.score.categories.map((c) => `${c.key} ${c.score}`).join(' · ')}`);
check('with a visit, loading and responsiveness are scored', !!cat(kit2, 'loading') && !!cat(kit2, 'responsiveness') && !!cat(islands2, 'loading'));
check('with a visit, the islands twin has hydration integrity scored', !!cat(islands2, 'hydration'), cat(islands2, 'hydration')?.value);
check('the islands twin still ranks well above (a fast machine\'s visit does not wash out the JS)', islands2.score.score >= kit2.score.score + 12, `${islands2.score.score} vs ${kit2.score.score}`);
check('the fully hydrated twin reported its visit too (the standalone beacon: no ogygia runtime there)', !!cat(kit2, 'loading'), cat(kit2, 'loading')?.value);

const failed = checks.filter((c) => !c).length;
console.log(failed ? `FAILED (${failed})` : 'the score ranks the twins right');
process.exit(failed ? 1 : 0);
