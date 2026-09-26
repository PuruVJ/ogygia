// HOLES ON A CACHED DOCUMENT (packages/ogygia/src/server/shared-cache.ts). A page whose load says
// `cache-control: public, s-maxage=604800, stale-while-revalidate=86400` is served from a CDN for up
// to 8 days; its deferred holes used to be signed for `regions.ttl` only, and every visitor of the
// cached copy got a 403 for every hole once that passed. Now:
//   1. an anonymous hole on such a page is signed for the page's cache life;
//   2. an EXPIRED capability (HTML cached before the fix, or a header set outside a load) renews:
//      the runtime retries once with `&renew=1`, the handle re-signs a URL it minted itself.
// The spec signs expired capabilities itself with the playground's OGYGIA_SECRET, exactly as the
// handle would have minted them hours or days ago.
import fs from 'node:fs';
import { test, check } from './fixtures/index.ts';
import { AMP_ENTITY_G_RE, ENDPOINT_ATTR_RE } from './fixtures/re.ts';
import { region_mac_message, sign } from '../packages/ogygia/dist/server/hmac.js';

const ENV_SECRET_RE = /^OGYGIA_SECRET=(.+)$/m;
const SECRET = (
	fs.readFileSync(new URL('../apps/playground/.env', import.meta.url), 'utf8').match(ENV_SECRET_RE)?.[1] ?? ''
).trim();
const DAY = 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

/** The first hole endpoint on a page, absolute. */
async function hole_endpoint(base: string, path: string): Promise<string> {
	const html = await (await fetch(base + path)).text();
	const m = html.match(ENDPOINT_ATTR_RE);
	return m ? new URL(m[1].replace(AMP_ENTITY_G_RE, '&'), base + path).href : '';
}

/** `endpoint` re-signed for another `exp`, as the handle minted it (anonymous, same ttl). */
function signed_at(endpoint: string, exp: number): string {
	const u = new URL(endpoint);
	const p = u.searchParams;
	const sig = sign(SECRET, region_mac_message(p.get('id') ?? '', String(exp), p.get('props') ?? '', '', p.get('ttl') ?? ''));
	p.set('exp', String(exp));
	p.set('sig', sig);
	return u.href;
}

test.describe('holes outlive a CDN-cached document', () => {
	test('mint: an anonymous hole on a shared-cacheable page is signed for the page’s cache life', async ({ baseURL }) => {
		const cached = await hole_endpoint(baseURL!, '/server-shared-cache');
		const plain = await hole_endpoint(baseURL!, '/server');
		const exp_cached = Number(new URL(cached).searchParams.get('exp'));
		const exp_plain = Number(new URL(plain).searchParams.get('exp'));
		check('the cached page carries a hole endpoint', !!cached);
		check('cached page: hole valid ≥ 8 days (s-maxage 7d + swr 1d)', exp_cached - now() >= 8 * DAY, `${((exp_cached - now()) / DAY).toFixed(1)} days`);
		check('non-cached page: hole keeps the short regions.ttl window', exp_plain - now() <= 3600, `${exp_plain - now()} s`);
		const res = await fetch(cached);
		check('the long-lived capability renders (200)', res.status === 200, String(res.status));
	});

	test('renew: the endpoint re-signs an expired capability it minted — and nothing else', async ({ baseURL }) => {
		check('playground secret found', SECRET.length > 0);
		const live = await hole_endpoint(baseURL!, '/server');
		const expired = signed_at(live, now() - 3600);

		const plain = await fetch(expired);
		check('expired capability, plain request → 403', plain.status === 403, String(plain.status));

		const renewed = await fetch(expired + '&renew=1');
		const fresh = renewed.headers.get('x-ogygia-capability') ?? '';
		check('expired capability, &renew=1 → 200', renewed.status === 200, String(renewed.status));
		check('the renewed answer is never cached', renewed.headers.get('cache-control') === 'no-store', String(renewed.headers.get('cache-control')));
		check('the renewed answer carries the fresh capability', fresh.startsWith('/') && fresh.includes('sig='), fresh);
		check('the renewed answer is the hole', (await renewed.text()).includes('data-server-greeting'));

		const again = await fetch(new URL(fresh, baseURL).href);
		check('the fresh capability works on its own (200)', again.status === 200, String(again.status));
		const fresh_exp = Number(new URL(fresh, baseURL).searchParams.get('exp'));
		check('the fresh capability is short-lived (regions.ttl)', fresh_exp > now() && fresh_exp - now() <= 3600, `${fresh_exp - now()} s`);

		const forged = new URL(expired);
		forged.searchParams.set('sig', '0'.repeat(64));
		const r_forged = await fetch(forged.href + '&renew=1');
		check('forged signature, &renew=1 → 403 (only URLs this app minted renew)', r_forged.status === 403, String(r_forged.status));

		const r_live = await fetch(live + '&renew=1');
		check('a capability that has not expired never renews → 403', r_live.status === 403, String(r_live.status));
		check('…and carries no fresh capability', !r_live.headers.get('x-ogygia-capability'));

		const r_old = await fetch(signed_at(live, now() - 9 * DAY) + '&renew=1');
		check('expired beyond the renew window (9 days) → 403', r_old.status === 403, String(r_old.status));

		const tampered = new URL(expired);
		tampered.searchParams.set('exp', String(now() - 7200)); // a different exp than the one signed
		const r_tampered = await fetch(tampered.href + '&renew=1');
		check('tampered exp, &renew=1 → 403 (the MAC covers the original exp)', r_tampered.status === 403, String(r_tampered.status));
	});

	test('browser: a stale document’s expired hole renews itself and fills', async ({ page, baseURL }) => {
		const live = await hole_endpoint(baseURL!, '/server');
		const lp = new URL(live).searchParams;
		const expired = new URL(signed_at(live, now() - 2 * 3600)).searchParams;
		// Serve /server as a cache would have kept it: the same document, its hole minted 2h+ ago.
		await page.route(`${baseURL}/server`, async (route) => {
			const res = await route.fetch();
			const html = (await res.text()).replaceAll(
				`exp=${lp.get('exp')}&amp;sig=${lp.get('sig')}`,
				`exp=${expired.get('exp')}&amp;sig=${expired.get('sig')}`
			);
			await route.fulfill({ response: res, body: html });
		});
		const hole_statuses: string[] = [];
		page.on('response', (r) => {
			if (r.url().includes('__ogygia__')) hole_statuses.push(`${r.status()}${r.url().includes('renew=1') ? ' renew' : ''}`);
		});
		await page.goto('/server', { waitUntil: 'domcontentloaded' });
		const filled = await page
			.waitForSelector('[data-server-greeting]', { timeout: 10_000 })
			.then(() => true)
			.catch(() => false);
		check('the stale hole fills', filled, hole_statuses.join(', '));
		check('it took one 403, then one renewal', hole_statuses.includes('403') && hole_statuses.includes('200 renew'), hole_statuses.join(', '));
		const endpoint_now = await page.getAttribute('ogygia-region[endpoint]', 'endpoint');
		const adopted = endpoint_now ? Number(new URL(endpoint_now, baseURL).searchParams.get('exp')) : 0;
		check('the hole adopted the fresh capability for its later fetches', adopted > now(), endpoint_now ?? 'no endpoint');
	});
});
