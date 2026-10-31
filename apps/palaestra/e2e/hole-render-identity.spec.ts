// A HOLE ADDRESS NAMES WHAT IT RENDERS (compiler/region/identity.ts `renderId`). A region id hashes
// the component, its page-side schedule and the build's salt; the endpoint used it as its render
// address, so a page cached across a deploy that only changed a preset, a `wake`, or the build's
// OGYGIA_SECRET had every hole refused (`unknown-id`) though the new build renders the same
// component. Every capability now also signs its render identity (`r`, the component alone), and a
// build that does not have the id answers it with its own entry for that component.
// The spec signs capabilities itself with the palaestra's OGYGIA_SECRET, as another build of the
// same app would have minted them.
//   pnpm exec playwright test hole-render-identity
import fs from 'node:fs';
import { test, check } from '@ogygia/tooling/e2e';
import { AMP_ENTITY_G_RE, ENDPOINT_ATTR_RE } from '@ogygia/tooling/e2e/re.ts';
import { region_mac_message, sign } from '../../../packages/core/dist/server/hmac.js';

const ENV_SECRET_RE = /^OGYGIA_SECRET=(.+)$/m;
const ENV_FILE = new URL('../.env', import.meta.url);
const SECRET = (
	process.env.OGYGIA_SECRET ??
	(fs.existsSync(ENV_FILE)
		? (fs.readFileSync(ENV_FILE, 'utf8').match(ENV_SECRET_RE)?.[1] ?? '')
		: '')
).trim();
/** a region id no build of this app minted */
const OTHER_BUILD_ID = 'a1b2c3d4e5f6';

async function hole_endpoint(base: string, path: string): Promise<string> {
	const html = await (await fetch(base + path)).text();
	const m = html.match(ENDPOINT_ATTR_RE);
	return m ? new URL(m[1].replace(AMP_ENTITY_G_RE, '&'), base + path).href : '';
}

/** `endpoint` as another build would have minted it: its own `id`, this `r` ('' = a v1 capability). */
function minted_as(endpoint: string, id: string, r: string): string {
	const u = new URL(endpoint);
	const p = u.searchParams;
	p.set('id', id);
	if (r) p.set('r', r);
	else p.delete('r');
	p.set(
		'sig',
		sign(
			SECRET,
			region_mac_message(id, p.get('exp') ?? '', p.get('props') ?? '', '', p.get('ttl') ?? '', r)
		)
	);
	return u.href;
}

/** the hole prints the time it rendered: everything else of an answer is the same render */
const RENDERED_AT_RE = /rendered on the server at [^<]*/g;

const answer = async (url: string) => {
	const res = await fetch(url);
	return {
		status: res.status,
		deny: res.headers.get('x-ogygia-deny'),
		body: res.status === 200 ? (await res.text()).replace(RENDERED_AT_RE, '') : ''
	};
};

test.describe('a hole capability names what it renders', () => {
	test('another build’s capability for the same component renders here', async ({ baseURL }) => {
		check('palaestra secret found', SECRET.length > 0);
		const live = await hole_endpoint(baseURL!, '/server');
		const r = new URL(live).searchParams.get('r') ?? '';
		check('a minted hole carries its render identity', /^[0-9a-f]{12}$/.test(r), live);

		const own = await answer(live);
		check('control: its own capability renders (200)', own.status === 200, String(own.status));

		const other = await answer(minted_as(live, OTHER_BUILD_ID, r));
		check(
			'an id this build does not have, same component → 200',
			other.status === 200,
			`${other.status} ${other.deny}`
		);
		check(
			'…with the same answer',
			other.body === own.body && own.body.includes('data-server-greeting')
		);

		const v1_own = await answer(minted_as(live, new URL(live).searchParams.get('id')!, ''));
		check(
			'a capability minted before render ids (v1), its id still here → 200',
			v1_own.status === 200,
			`${v1_own.status} ${v1_own.deny}`
		);
	});

	test('nothing else is answered', async ({ baseURL }) => {
		const live = await hole_endpoint(baseURL!, '/server');
		const r = new URL(live).searchParams.get('r') ?? '';

		const v1_other = await answer(minted_as(live, OTHER_BUILD_ID, ''));
		check(
			'v1 with an id this build does not have → 403 unknown-id',
			v1_other.status === 403 && v1_other.deny === 'unknown-id',
			`${v1_other.status} ${v1_other.deny}`
		);

		const gone = await answer(minted_as(live, OTHER_BUILD_ID, 'b0b0b0b0b0b0'));
		check(
			'a component this build does not render → 403 unknown-id',
			gone.status === 403 && gone.deny === 'unknown-id',
			`${gone.status} ${gone.deny}`
		);

		const stripped = new URL(minted_as(live, OTHER_BUILD_ID, r));
		stripped.searchParams.delete('r');
		const s = await answer(stripped.href);
		check(
			'stripping r from a signed capability → 403 sig',
			s.status === 403 && s.deny === 'sig',
			`${s.status} ${s.deny}`
		);

		const swapped = new URL(minted_as(live, OTHER_BUILD_ID, r));
		swapped.searchParams.set('r', 'b0b0b0b0b0b0');
		const w = await answer(swapped.href);
		check(
			're-pointing r at another component → 403 sig',
			w.status === 403 && w.deny === 'sig',
			`${w.status} ${w.deny}`
		);

		const bad = new URL(live);
		bad.searchParams.set('r', 'not-a-render-id');
		const b = await answer(bad.href);
		check(
			'a malformed r → 403 shape',
			b.status === 403 && b.deny === 'shape',
			`${b.status} ${b.deny}`
		);
	});
});
