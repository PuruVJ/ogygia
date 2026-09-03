// Node fetch-based SSR assertions. Usage: pnpm exec playwright test fetch-checks
import { test, check } from './fixtures/index.ts';
import { KIT_MARKER_RE, REGION_OPEN_G_RE } from './fixtures/re.ts';

const COUNT_10_RE = /count is 10/;
const COUNT_99_RE = /count is 99/;
const COUNT_42_RE = /count is 42/;
const ROUTER_MARKER_RE = /name="ogygia-router"/;
const ROUTER_MARKER_G_RE = /name="ogygia-router"/g;
const ROUTER_VT_RE = /name="ogygia-router" content="vt"/;
const ROUTER_PLAIN_RE = /name="ogygia-router" content="plain"/;
const ALPHA_RE = /Alpha/;
const BRAVO_RE = /Bravo/;
const CHARLIE_RE = /Charlie/;
const PROPS_PAYLOAD_RE = /application\/ogygia-props/;
const PROPS_PAYLOAD_G_RE = /application\/ogygia-props/g;
const DATE_OK_RE = /date instanceof Date: true/;
const MAP_OK_RE = /map instanceof Map: true/;
const SET_OK_RE = /set instanceof Set: true/;
const NESTED_OK_RE = /nested-ok/;
const SNIPPET_Y_RE = /y = 42/;
const RUNTIME_SRC_RE = /src="[^"]*og-runtime[^"]*"/;
const RUNTIME_BOOTSTRAP_G_RE = /data-ogygia-runtime/g;
const MODULEPRELOAD_RE = /rel="modulepreload"/i;
const KIT_ENTRY_START_RE = /entry\/start/;
const CLOCK_ISLAND_RE = /Clock island/;
const HELLO_WORLD_RE = /Hello, world!/;
const PENDING_SNIPPET_RE = /SSR renders this pending snippet/;
const HELLO_LAZILY_RE = /Hello, lazily!/;
const LIVE_CLOCK_PENDING_RE = /connecting to live clock/;
const ISLAND_CSS_RE = /\.island\s*\{/;
const OGYGIA_RUNTIME_RE = /ogygia-runtime/;
const KIT_PATH_RE = /path: <strong>\/kit/;

async function get(base: string, path: string) {
	const res = await fetch(base + path);
	return { status: res.status, ct: res.headers.get('content-type') || '', html: await res.text() };
}

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

test.describe('SSR island HTML, no Kit bootstrap', () => {
	test('Home', async ({ baseURL }) => {
		const { status, html } = await get(baseURL, '/');
		check('/ returns 200', status === 200);
		check(
			'/ has 9 <ogygia-region> elements',
			count(html, REGION_OPEN_G_RE) === 9,
			`${count(html, REGION_OPEN_G_RE)}`
		);
		check('/ counter island SSR content (count is 10)', COUNT_10_RE.test(html));
		check('/ per-use strategy: same module, visible (count is 99)', COUNT_99_RE.test(html));
		check('/ global router marker present (handle-injected)', ROUTER_MARKER_RE.test(html));
		check('/ router marker defaults to view transitions', ROUTER_VT_RE.test(html));
		check(
			'/ each-block islands SSR (Alpha/Bravo/Charlie)',
			ALPHA_RE.test(html) && BRAVO_RE.test(html) && CHARLIE_RE.test(html)
		);
		check('/ devalue props payload present', PROPS_PAYLOAD_RE.test(html));
		check('/ 9 devalue payloads', count(html, PROPS_PAYLOAD_G_RE) === 9);
		check('/ devalue Date survives SSR (instanceof true)', DATE_OK_RE.test(html));
		check('/ devalue Map survives SSR', MAP_OK_RE.test(html));
		check('/ devalue Set survives SSR', SET_OK_RE.test(html));
		check('/ nested object survives SSR', NESTED_OK_RE.test(html));
		check('/ snippet island sees outer var (y = 42)', SNIPPET_Y_RE.test(html));
		check('/ runtime module script tag present', RUNTIME_SRC_RE.test(html));
		check(
			'/ single data-ogygia-runtime bootstrap (not per-island)',
			count(html, RUNTIME_BOOTSTRAP_G_RE) === 1,
			`${count(html, RUNTIME_BOOTSTRAP_G_RE)}`
		);
		{
			const head = html.slice(0, html.indexOf('</head>'));
			check(
				'/ hydrate=load modulepreload(s) in <head>',
				MODULEPRELOAD_RE.test(head),
				MODULEPRELOAD_RE.test(head) ? 'in head' : 'missing from head'
			);
		}
		check('/ NO Kit __sveltekit bootstrap', !KIT_MARKER_RE.test(html));
		check('/ NO Kit entry/start script', !KIT_ENTRY_START_RE.test(html));
	});

	test('About', async ({ baseURL }) => {
		const { status, html } = await get(baseURL, '/about');
		check('/about returns 200', status === 200);
		check('/about Clock island SSR', CLOCK_ISLAND_RE.test(html));
		check('/about NO Kit bootstrap', !KIT_MARKER_RE.test(html));
	});

	test('Data (remote functions)', async ({ baseURL }) => {
		const { status, html } = await get(baseURL, '/data');
		check('/data returns 200', status === 200);
		check('/data mode (a): resolved query in SSR HTML (Hello, world!)', HELLO_WORLD_RE.test(html));
		check('/data mode (b): pending snippet SSR (not resolved)', PENDING_SNIPPET_RE.test(html));
		check('/data mode (b): resolved greeting NOT in SSR', !HELLO_LAZILY_RE.test(html));
		check('/data live clock pending SSR', LIVE_CLOCK_PENDING_RE.test(html));
		check('/data NO Kit bootstrap', !KIT_MARKER_RE.test(html));
	});

	test('Plain page: global router still applies, but this page opts OUT of view transitions', async ({
		baseURL
	}) => {
		const { status, html } = await get(baseURL, '/plain');
		check('/plain returns 200', status === 200);
		check('/plain has an island (still hydrates)', count(html, REGION_OPEN_G_RE) === 1);
		check('/plain router marker present (router is global)', ROUTER_MARKER_RE.test(html));
		check('/plain page opts out of view transitions (content="plain")', ROUTER_PLAIN_RE.test(html));
		check(
			'/plain single router marker (page tag wins, handle skips)',
			count(html, ROUTER_MARKER_G_RE) === 1,
			`${count(html, ROUTER_MARKER_G_RE)}`
		);
		check('/plain NO Kit bootstrap (csr=false island page)', !KIT_MARKER_RE.test(html));
	});

	test('Nested deep route: island CSS must reach the INITIAL <head> (no FOUC on hard reload)', async ({
		baseURL
	}) => {
		const { status, html } = await get(baseURL, '/dashboard/orders/5');
		check('/dashboard/orders/5 returns 200', status === 200);
		const head = html.slice(0, html.indexOf('</head>'));
		// The island component's `.island` CSS is inlined into <head> at SSR (via the page import
		// graph), so the shell paints styled — a nested-route CSS-in-head sanity check.
		check(
			'deep route: island CSS present in initial <head>',
			ISLAND_CSS_RE.test(head),
			head.includes('.island') ? 'in head' : 'MISSING'
		);
	});

	test('Kit page (csr=true coexistence demo): full Kit hydration + an island', async ({
		baseURL
	}) => {
		const { status, html } = await get(baseURL, '/kit');
		check('/kit returns 200', status === 200);
		check('/kit IS a normal hydrated Kit page (has __sveltekit)', KIT_MARKER_RE.test(html));
		// csr=true → ogygia steps aside entirely: the island compiles to a plain component (Kit hydrates
		// it), so NO <ogygia-region> and NO runtime script. Zero ogygia on a csr=true page.
		check('/kit ships ZERO ogygia (no <ogygia-region>)', count(html, REGION_OPEN_G_RE) === 0);
		check('/kit ships ZERO ogygia (no runtime script)', !OGYGIA_RUNTIME_RE.test(html));
		check('/kit island SSR content still present (count is 42)', COUNT_42_RE.test(html));
		check('/kit normal component SSR (real $app/state path)', KIT_PATH_RE.test(html));
	});
});
