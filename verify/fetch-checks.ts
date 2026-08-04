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
	check('/ opt-in router marker present (ClientRouter)', /name="ogygia-router"/.test(html));
	check('/ each-block islands SSR (Alpha/Bravo/Charlie)', /Alpha/.test(html) && /Bravo/.test(html) && /Charlie/.test(html));
	check('/ devalue props payload present', /application\/sk-island-props/.test(html));
	check('/ 9 devalue payloads', count(html, /application\/sk-island-props/g) === 9);
	check('/ devalue Date survives SSR (instanceof true)', /date instanceof Date: true/.test(html));
	check('/ devalue Map survives SSR', /map instanceof Map: true/.test(html));
	check('/ devalue Set survives SSR', /set instanceof Set: true/.test(html));
	check('/ nested object survives SSR', /nested-ok/.test(html));
	check('/ snippet island sees outer var (y = 42)', /y = 42/.test(html));
	check('/ runtime module script tag present', /src="[^"]*ogygia-runtime[^"]*"/.test(html));
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

// --- Plain page: island page (csr=false) that opted OUT of the router ---
{
	const { status, html } = await get('/plain');
	check('/plain returns 200', status === 200);
	check('/plain has an island (still hydrates)', count(html, /<ogygia-region/g) === 1);
	check('/plain has NO router marker (opt-out)', !/name="ogygia-router"/.test(html));
	check('/plain NO Kit bootstrap (csr=false island page)', !/__sveltekit/.test(html));
}

// --- Kit page (csr=true coexistence demo): full Kit hydration + an island ---
{
	const { status, html } = await get('/kit');
	check('/kit returns 200', status === 200);
	check('/kit IS a normal hydrated Kit page (has __sveltekit)', /__sveltekit/.test(html));
	check('/kit still SSRs its island (<ogygia-region>)', count(html, /<ogygia-region/g) === 1);
	check('/kit island SSR content (count is 42)', /count is 42/.test(html));
	check('/kit normal component SSR (real $app/state path)', /path: <strong>\/kit/.test(html));
}

console.log(`\n${failures === 0 ? 'ALL SSR CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);

export {};
