// RATE-BURN: forged signatures must NOT burn the per-IP budget (verify MAC first, then charge).
// Usage: node verify/region-rate.ts [baseUrl]
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
function check(name, cond, extra = '') {
	if (!cond) failures++;
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const page = await fetch(base + '/server');
const html = await page.text();
const m = html.match(/endpoint="([^"]*)"/);
const endpoint = m ? new URL(m[1].replace(/&amp;/g, '&'), base + '/server').href : '';
check('have signed endpoint', !!endpoint);

const forged = new URL(endpoint);
forged.searchParams.set('sig', '0'.repeat(64));

const statuses = await Promise.all(
	Array.from({ length: 80 }, () => fetch(forged.href).then((r) => r.status))
);
const denied = statuses.filter((s) => s === 429).length;
const forbidden = statuses.filter((s) => s === 403).length;
// After RATE-BURN fix: junk MACs are all 403 and never 429 (budget untouched).
check('forged flood never hits rate limit', denied === 0, `429=${denied} 403=${forbidden}`);
check('forged flood is all forbidden', forbidden === 80, `got 429=${denied} 403=${forbidden}`);

// A single valid request after the flood must still succeed (budget not burned by junk).
const valid = await fetch(endpoint);
check('valid request still serves after forged flood', valid.ok, `status=${valid.status}`);

console.log(failures === 0 ? '\nALL REGION-RATE CHECKS PASSED' : `\n${failures} REGION-RATE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
