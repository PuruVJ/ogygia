// Node fetch-based SSR assertions. Usage: node verify/fetch-checks.mjs [baseUrl]
const base = process.argv[2] || 'http://localhost:3051';

let failures = 0;
function check(name, cond, extra = '') {
	const ok = !!cond;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!ok) failures++;
}

async function get(path) {
	const res = await fetch(base + path);
	return { status: res.status, ct: res.headers.get('content-type') || '', html: await res.text() };
}

const count = (s, re) => (s.match(re) || []).length;

// --- Home ---
{
	const { status, html } = await get('/');
	check('/ returns 200', status === 200);
	check('/ has 9 <ogygia-region> elements', count(html, /<ogygia-region/g) === 9, `${count(html, /<ogygia-region/g)}`);
	check('/ counter island SSR content (count is 10)', /count is 10/.test(html));
	check('/ per-use strategy: same module, visible (count is 99)', /count is 99/.test(html));
	check('/ global router marker present (handle-injected)', /name="ogygia-router"/.test(html));
	check('/ router marker defaults to view transitions', /name="ogygia-router" content="vt"/.test(html));
	check('/ each-block islands SSR (Alpha/Bravo/Charlie)', /Alpha/.test(html) && /Bravo/.test(html) && /Charlie/.test(html));
	check('/ devalue props payload present', /application\/ogygia-props/.test(html));
	check('/ 9 devalue payloads', count(html, /application\/ogygia-props/g) === 9);
	check('/ devalue Date survives SSR (instanceof true)', /date instanceof Date: true/.test(html));
	check('/ devalue Map survives SSR', /map instanceof Map: true/.test(html));
	check('/ devalue Set survives SSR', /set instanceof Set: true/.test(html));
	check('/ nested object survives SSR', /nested-ok/.test(html));
	check('/ snippet island sees outer var (y = 42)', /y = 42/.test(html));
	check('/ runtime module script tag present', /src="[^"]*ogygia-runtime[^"]*"/.test(html));
	check(
		'/ single data-ogygia-runtime bootstrap (not per-island)',
		count(html, /data-ogygia-runtime/g) === 1,
		`${count(html, /data-ogygia-runtime/g)}`
	);
	{
		const head = html.slice(0, html.indexOf('</head>'));
		check(
			'/ hydrate=load modulepreload(s) in <head>',
			/rel="modulepreload"/i.test(head),
			/rel="modulepreload"/i.test(head) ? 'in head' : 'missing from head'
		);
	}
	check('/ NO Kit __sveltekit bootstrap', !/__sveltekit/.test(html));
	check('/ NO Kit entry/start script', !/entry\/start/.test(html));
}

// --- About ---
{
	const { status, html } = await get('/about');
	check('/about returns 200', status === 200);
	check('/about Clock island SSR', /Clock island/.test(html));
	check('/about NO Kit bootstrap', !/__sveltekit/.test(html));
}

// --- Data (remote functions) ---
{
	const { status, html } = await get('/data');
	check('/data returns 200', status === 200);
	check('/data mode (a): resolved query in SSR HTML (Hello, world!)', /Hello, world!/.test(html));
	check('/data mode (b): pending snippet SSR (not resolved)', /SSR renders this pending snippet/.test(html));
	check('/data mode (b): resolved greeting NOT in SSR', !/Hello, lazily!/.test(html));
	check('/data live clock pending SSR', /connecting to live clock/.test(html));
	check('/data NO Kit bootstrap', !/__sveltekit/.test(html));
}

// --- Plain page: global router still applies, but this page opts OUT of view transitions ---
{
	const { status, html } = await get('/plain');
	check('/plain returns 200', status === 200);
	check('/plain has an island (still hydrates)', count(html, /<ogygia-region/g) === 1);
	check('/plain router marker present (router is global)', /name="ogygia-router"/.test(html));
	check('/plain page opts out of view transitions (content="plain")', /name="ogygia-router" content="plain"/.test(html));
	check('/plain single router marker (page tag wins, handle skips)', count(html, /name="ogygia-router"/g) === 1, `${count(html, /name="ogygia-router"/g)}`);
	check('/plain NO Kit bootstrap (csr=false island page)', !/__sveltekit/.test(html));
}

// --- Nested deep route: island CSS must reach the INITIAL <head> (no FOUC on hard reload) ---
{
	const { status, html } = await get('/dashboard/orders/5');
	check('/dashboard/orders/5 returns 200', status === 200);
	const head = html.slice(0, html.indexOf('</head>'));
	// The island component's `.island` CSS is inlined into <head> at SSR (via the page import
	// graph), so the shell paints styled — a nested-route CSS-in-head sanity check.
	check('deep route: island CSS present in initial <head>', /\.island\s*\{/.test(head), head.includes('.island') ? 'in head' : 'MISSING');
}

// --- Kit page (csr=true coexistence demo): full Kit hydration + an island ---
{
	const { status, html } = await get('/kit');
	check('/kit returns 200', status === 200);
	check('/kit IS a normal hydrated Kit page (has __sveltekit)', /__sveltekit/.test(html));
	// csr=true → ogygia steps aside entirely: the island compiles to a plain component (Kit hydrates
	// it), so NO <ogygia-region> and NO runtime script. Zero ogygia on a csr=true page.
	check('/kit ships ZERO ogygia (no <ogygia-region>)', count(html, /<ogygia-region/g) === 0);
	check('/kit ships ZERO ogygia (no runtime script)', !/ogygia-runtime/.test(html));
	check('/kit island SSR content still present (count is 42)', /count is 42/.test(html));
	check('/kit normal component SSR (real $app/state path)', /path: <strong>\/kit/.test(html));
}

console.log(`\n${failures === 0 ? 'ALL SSR CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);

export {};
