/**
 * Self-contained smoke of the federation demo: mints throwaway Ed25519 keys, boots the three
 * adapter-node builds, and curls every seam — SSR stitch, whole-app mount, identity, sticky +
 * overridable experiments, three-hop trace continuity, the lazy-stitch proxy, the signature
 * gate, and failure isolation. Build first, then:  node smoke.mjs
 */
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const pair = () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
		priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
	};
};
const shell_keys = pair();
const cms_keys = pair();

const SHELL = 'http://localhost:5180';
const CMS = 'http://localhost:5182';
const DASH = 'http://localhost:5181';

const common = {
	SHELL_PUBLIC_KEY: shell_keys.pub,
	CMS_PUBLIC_KEY: cms_keys.pub
};
const apps = {
	dash: { port: 5181, env: { ORIGIN: DASH, ...common } },
	cms: {
		port: 5182,
		env: { ORIGIN: CMS, DASH_ORIGIN: DASH, CMS_SIGNING_KEY: cms_keys.priv, ...common }
	},
	shell: {
		port: 5180,
		env: {
			ORIGIN: SHELL,
			CMS_ORIGIN: CMS,
			DASH_ORIGIN: DASH,
			SHELL_SIGNING_KEY: shell_keys.priv,
			...common
		}
	}
};

const procs = {};
for (const [name, { port, env }] of Object.entries(apps)) {
	// serve.mjs, not build/index.js: it adds the asset-CORS header a FOREIGN page's dynamic
	// import() needs (in production that header lives on the MFE's CDN — without it, foreign
	// islands silently degrade: "Failed to fetch dynamically imported module")
	procs[name] = spawn('node', ['serve.mjs', name, String(port)], {
		cwd: new URL('.', import.meta.url).pathname,
		env: { ...process.env, ...env },
		stdio: 'ignore'
	});
}
const kill_all = () => Object.values(procs).forEach((p) => p.kill());
process.on('exit', kill_all);

const until_up = async (origin) => {
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(origin + '/', { signal: AbortSignal.timeout(500) });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 200));
		}
	}
	throw new Error(`${origin} never came up`);
};
await Promise.all([until_up(DASH), until_up(CMS), until_up(SHELL)]);

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
	if (!ok) failures++;
};

// 1) SSR stitch: dash's widget baked into the shell's first paint (admin KPI = claims arrived)
{
	const html = await (await fetch(SHELL + '/')).text();
	check('SSR stitch: dash fragment in shell paint', html.includes('data-testid="dash-fragment"'));
	check('claims reached dash (admin KPI rendered)', html.includes('data-testid="admin-kpi"'));
}

// 2) whole-app mount + identity + three-hop trace + per-team Server-Timing
{
	const trace_id = 'a'.repeat(32);
	const res = await fetch(SHELL + '/cms/', {
		headers: { traceparent: `00-${trace_id}-${'b'.repeat(16)}-01` }
	});
	const html = await res.text();
	check('mount: cms home under shell chrome', html.includes('data-testid="cms-home"'));
	check('identity: c.visitor reached the cms', html.includes('salut puru'));
	check(
		'trace: shell trace-id reaches dash 2 hops deep',
		html.includes(`data-dash-trace="${trace_id}"`)
	);
	const st = res.headers.get('server-timing') ?? '';
	check('observability: per-team Server-Timing on the shell response', /-render;dur=/.test(st), st);
}

// 2b) STATUS CHANNEL: the cms's own 404 page answers 404 THROUGH the shell
{
	const res = await fetch(SHELL + '/cms/definitely-missing-page');
	const html = await res.text();
	check(
		'status channel: mounted 404 answers 404 (not 200-wrapped)',
		res.status === 404,
		'got ' + res.status
	);
	check("status channel: the MFE's OWN error page renders", html.includes('does not exist'));
	// boundary chrome nesting: the error page renders INSIDE its own layout's chrome (the cms
	// shell), not floating bare — a page-load failure keeps every working layout
	check('boundary renders INSIDE its layout chrome', html.includes('data-testid="cms-shell"'));
}

// 2c) kitMount: the SAME cms app mounted from a PLAIN Kit catchall (no ogygia router)
{
	const res = await fetch(SHELL + '/cms-kit/');
	const html = await res.text();
	check('kitMount: cms home through a plain Kit catchall', html.includes('data-testid="cms-home"'));
	check('kitMount: identity flows (session claims signed in)', html.includes('salut puru'));
	const miss = await fetch(SHELL + '/cms-kit/definitely-missing-page');
	check(
		'kitMount: upstream 404 → Kit error(404), right status',
		miss.status === 404,
		'got ' + miss.status
	);
}

// 3) experiments: sticky assignment auto-carried into the mounted app + QA override
{
	const read_stamp = async (q = '') => {
		const html = await (await fetch(SHELL + '/cms/lab' + q)).text();
		return html.match(/data-og-exp="([^"]+)"/)?.[1];
	};
	const a = await read_stamp();
	const b = await read_stamp();
	check('experiment: assigned + carried through the mount', !!a && a.startsWith('csr-mode:'), a);
	check('experiment: sticky across requests', a === b, `${a} vs ${b}`);
	const forced = await read_stamp('?og-exp=csr-mode:static');
	check(
		'experiment: ?og-exp override rides the signed claims',
		forced === 'csr-mode:static',
		forced
	);
}

// 4) a deferred remote widget: the shell home emits a shell-signed hole; fetching it returns dash
{
	const home = await (await fetch(SHELL + '/')).text();
	const hole = home.match(/\/og\/frag\?[^"]+/)?.[0]?.replace(/&amp;/g, '&');
	check('deferred: the home emitted an /og/frag hole', !!hole);
	if (hole) {
		const frag = await (await fetch(SHELL + hole)).text();
		check('deferred: the hole rendered the dash widget', /dash-fragment/.test(frag));
	}
	const forged = await fetch(
		SHELL + '/og/frag?peer=dash&kind=widget&target=kpis&search=&exp=9999999999999&sig=bad'
	);
	check('deferred: a forged hole capability is rejected', forged.status === 403);
}

// 5) the signature gate: unsigned callers learn nothing
{
	const res = await fetch(CMS + '/og/fragment/page?path=/');
	check('security: unsigned fragment call → 401', res.status === 401);
}

// 5b) THE BROWSER TRUTH: foreign islands actually hydrate and respond. HTML checks can't see a
// CORS-dead dynamic import() — this is the check that catches it (and it did: the raw
// adapter-node servers shipped no asset-CORS header and every foreign island silently degraded).
{
	const { chromium } = await import('playwright');
	const b = await chromium.launch();
	const bpage = await b.newPage();
	const bad = [];
	bpage.on('console', (m) => {
		if (m.type() === 'error' || /Failed to hydrate|hydration failed/i.test(m.text()))
			bad.push(m.text().slice(0, 140));
	});
	bpage.on('pageerror', (e) => bad.push('page: ' + e.message.slice(0, 140)));
	await bpage.goto(SHELL + '/', { waitUntil: 'networkidle' });
	await bpage.waitForTimeout(500);
	const counter = bpage.locator('[data-testid="dash-counter"]').first();
	const before = await counter.innerText().catch(() => '');
	await counter.click().catch(() => {});
	await bpage.waitForTimeout(120);
	const after = await counter.innerText().catch(() => '');
	check(
		'browser: FOREIGN island interactive (dash counter clicks)',
		before !== after && after !== '',
		`${before} -> ${after}`
	);
	check('browser: zero hydration failures / page errors', bad.length === 0, bad.join(' | '));
	await b.close();
}

// 6) failure isolation: dead MFE, shell page unharmed
{
	procs.dash.kill();
	await new Promise((r) => setTimeout(r, 300));
	const res = await fetch(SHELL + '/');
	const html = await res.text();
	check('isolation: shell renders 200 with dash dead', res.status === 200);
	check('isolation: inline card, not a broken page', html.includes('unavailable'));
}

kill_all();
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
