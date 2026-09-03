// ESI DEMO — is edge stitching working? Boots the freeze fixture (origin) behind a local Akamai
// emulator that PROCESSES ESI (and a CloudFront one that does not), then walks the story with real
// HTTP and prints what each hop answered. Run from the repo root:
//
//     node e2e/demo/esi.ts            # builds the fixture first (SKIP_BUILD=1 to reuse a build)
//
// What you should see: origin stores the shell ONCE with an <esi:include> where the header goes and
// `Surrogate-Control: content="ESI/1.0"`; the edge serves that shell from cache (HIT) while fetching
// only the header include per request WITH your cookie — so a cookied request is an edge hit that
// still says "Hello, Puru". The CloudFront hop shows the degrade: tags pass through, the fallback
// ships, the browser would fetch the hole itself.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { start_edge_emulator, type EdgeEmulator } from '../freeze-emulator.ts';
import { spawn_server, type SpawnedServer } from '../fixtures/servers.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const dir = path.join(repo, 'internal', 'repro-freeze');
const ORIGIN_PORT = 3093;
const AKAMAI_PORT = 3094;
const CF_PORT = 3095;
const origin = `http://127.0.0.1:${ORIGIN_PORT}`;
const PAGE = '/fr/fr/esi';

const ok = (b: boolean) => (b ? '✓' : '✗');
const say = (line: string) => console.log(line);
const head = (t: string) => say(`\n\x1b[1m${t}\x1b[0m`);
const kv = (k: string, v: string | null | undefined) => say(`   ${k.padEnd(24)} ${v ?? '(none)'}`);
const snippet = (html: string, needle: string, width = 110) => {
	const at = html.indexOf(needle);
	return at === -1 ? '(absent)' : html.slice(at, at + width).replace(/\s+/g, ' ') + '…';
};

let srv: SpawnedServer | undefined;
let akamai: EdgeEmulator | undefined;
let cf: EdgeEmulator | undefined;
const bye = async (code: number) => {
	srv?.kill();
	await akamai?.close();
	await cf?.close();
	process.exit(code);
};

try {
	if (!process.env.SKIP_BUILD) {
		head('building the freeze fixture (consumes the live workspace ogygia)…');
		const built = spawnSync('pnpm', ['--dir', dir, 'build'], { stdio: 'inherit' });
		if (built.status !== 0) throw new Error('fixture build failed');
	}

	head('booting: origin → cloudfront emulator (no ESI) → akamai emulator (ESI)');
	cf = await start_edge_emulator({ name: 'cloudfront', port: CF_PORT, upstream: origin });
	akamai = await start_edge_emulator({ name: 'akamai', port: AKAMAI_PORT, upstream: cf.base });
	srv = await spawn_server({
		cmd: 'node',
		args: ['build/index.js'],
		cwd: dir,
		env: {
			PORT: String(ORIGIN_PORT),
			ORIGIN: origin,
			EDGE_AKAMAI_URL: akamai.base,
			EDGE_CF_URL: cf.base,
			EDGE_SITE_URL: origin
		},
		url: origin + '/api/state',
		ready: (res) => res.ok
	});
	const renders = async () =>
		((await (await fetch(origin + '/api/state')).json()).renders ?? {})[PAGE] ?? 0;

	// SERVE=1: boot and STAY UP (cold caches) so a human can click through it in a browser.
	if (process.env.SERVE) {
		head('up — open these in a browser (Ctrl+C to stop):');
		say(`   ESI edge (akamai)      ${akamai.base}${PAGE}`);
		say(`   origin                 ${origin}${PAGE}`);
		say(`   non-ESI edge (cf)      ${cf.base}${PAGE}`);
		say(`   edge state             ${akamai.base}/__edge/state`);
		say(`   origin render counts   ${origin}/api/state`);
		say(`   log in / out           ${origin}/api/user?name=Puru   ·   ${origin}/api/user`);
		const stop = () => void bye(0);
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
		await new Promise<void>(() => {});
	}

	head(`1. ORIGIN, cold — GET ${PAGE} (no cookie)`);
	const o1 = await fetch(origin + PAGE);
	const o1_html = await o1.text();
	kv('x-ogygia-freeze', o1.headers.get('x-ogygia-freeze'));
	kv('cache-control', o1.headers.get('cache-control'));
	kv('surrogate-control', o1.headers.get('surrogate-control'));
	kv('etag', o1.headers.get('etag'));
	say(
		`   the hole in the stored bytes:\n     ${snippet(o1_html, '<esi:remove>')}\n     ${snippet(o1_html, '<esi:include')}`
	);
	say(
		`   ${ok(o1.headers.get('x-ogygia-freeze') === 'stored')} stored ONCE, edge-cacheable, ESI announced`
	);

	head(`2. EDGE (akamai), anonymous — GET ${PAGE}`);
	const e1 = await fetch(akamai.base + PAGE);
	const e1_html = await e1.text();
	kv('x-edge-akamai', e1.headers.get('x-edge-akamai'));
	kv('x-edge-akamai-esi', e1.headers.get('x-edge-akamai-esi'));
	kv('header in the body', snippet(e1_html, 'Hello, ', 30));
	say(
		`   ${ok(!e1_html.includes('<esi:'))} no esi tags reach the browser  ${ok(e1_html.includes('Hello, guest'))} guest header spliced`
	);

	head(`3. EDGE (akamai), cookie user=Puru — GET ${PAGE}   ← THE MONEY SHOT`);
	const e2 = await fetch(akamai.base + PAGE, { headers: { cookie: 'user=Puru' } });
	const e2_html = await e2.text();
	kv('x-edge-akamai', e2.headers.get('x-edge-akamai'));
	kv('x-edge-akamai-esi', e2.headers.get('x-edge-akamai-esi'));
	kv('header in the body', snippet(e2_html, 'Hello, ', 30));
	const money = e2.headers.get('x-edge-akamai') === 'hit' && e2_html.includes('Hello, Puru');
	say(
		`   ${ok(money)} shell served from the EDGE CACHE (hit) AND personalized (include fetched with the cookie)`
	);

	head('4. ORIGIN render count for the shell');
	const n = await renders();
	kv('renders', String(n));
	say(
		`   ${ok(n === 1)} origin rendered the shell exactly once — every serve after that is edge cache + one hole render`
	);
	const st = (await (await fetch(akamai.base + '/__edge/state')).json()) as {
		hits: number;
		misses: number;
		esi: number;
	};
	kv('edge hits / misses', `${st.hits} / ${st.misses}`);
	kv('includes fetched', String(st.esi));

	head(`5. A NON-ESI edge (cloudfront), cookie user=Puru — the degrade path`);
	const c1 = await fetch(cf.base + PAGE, { headers: { cookie: 'user=Puru' } });
	const c1_html = await c1.text();
	kv('x-edge-cloudfront', c1.headers.get('x-edge-cloudfront'));
	say(
		`   ${ok(c1_html.includes('<esi:include'))} esi tags pass through untouched  ${ok(c1_html.includes('data-stitch-fallback'))} the fallback ships (the browser then fetches the hole)`
	);

	const all = o1.headers.get('x-ogygia-freeze') === 'stored' && money && n === 1;
	head(all ? '✓ ESI edge stitching WORKS end to end' : '✗ something is off — read the marks above');
	await bye(all ? 0 : 1);
} catch (e) {
	console.error('\n✗ demo failed:', e instanceof Error ? e.message : e);
	await bye(1);
}
