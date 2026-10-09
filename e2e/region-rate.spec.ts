// RATE-BURN: forged signatures must NOT burn the per-IP budget (verify MAC first, then charge).
// Usage: pnpm exec playwright test region-rate
import { test, check } from './fixtures/index.ts';
import { AMP_ENTITY_G_RE, ENDPOINT_ATTR_RE } from './fixtures/re.ts';

test.describe('forged-MAC flood → all 403, budget intact', () => {
	test('a forged flood is all 403, never 429, and a valid request still serves after it', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/server');
		const html = await res.text();
		const m = html.match(ENDPOINT_ATTR_RE);
		const endpoint = m ? new URL(m[1].replace(AMP_ENTITY_G_RE, '&'), baseURL + '/server').href : '';
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
	});
});
