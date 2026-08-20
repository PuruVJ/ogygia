// Portable island bindings (0.4.0): marked imports are values — static tag, dynamic <Comp />,
// and each/list share one entry module. csr=false client hosts omit wrappers (scale).
// Usage: node verify/portable-bindings.ts [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	transformHost,
	transformTsRegions,
	regionIdentity,
	regionId,
	CLIENT_BINDING_STUB
} from '../packages/ogygia/dist/compiler/transform.js';

const base = process.argv[2] || 'http://localhost:3051';
const repo = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- Transform: dedupe identity (unit-level, no server) ----------
{
	const ROOT = '/app';
	const HOST = '/app/src/routes/+page.svelte';
	const ctx = {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
		devUrlFor: (p: string) => '/@id/' + p,
		visibleMargin: '0px',
		presets: {}
	};
	const src = `<script>
import A from './A.svelte' with { wake: 'load' };
import B from './A.svelte' with { wake: 'load' };
const Dyn = A;
const list = [{ Comp: A, props: { n: 1 } }, { Comp: B, props: { n: 2 } }];
</script>
<A n={1} />
<A n={2} />
<Dyn n={3} />
{#each list as { Comp, props }}<Comp {...props} />{/each}
`;
	const r = transformHost(src, HOST, ctx);
	check(
		'transform: portable rewrite points A at its attach binding (placeable + holdable)',
		!!r && /import A from "virtual:ogygia\/region\//.test(r.code)
	);
	check(
		'transform: two imports same path+strategy → one island id',
		r!.islands.length === 1,
		`count=${r?.islands.length}`
	);
	const id = regionId(regionIdentity('src/routes/A.svelte', { strategy: 'load', options: {} }));
	check(
		'transform: identity id matches component path + strategy',
		r!.islands[0].id === id,
		r!.islands[0]?.id
	);
	check(
		'transform: shared entry virtual path',
		r!.islands[0].virtualPath === `virtual:ogygia/island/${id}.js`
	);
	check(
		'transform: dynamic Comp + each allowed (no static-tag error)',
		!/never used as a static/.test(r!.code)
	);

	const omit = transformHost(src, HOST, { ...ctx, linkVirtualIsland: false });
	check(
		'transform: csr=false omit uses client binding stub',
		!!omit && omit.code.includes(CLIENT_BINDING_STUB) && !/virtual:ogygia\/wrapper\//.test(omit.code)
	);
	check(
		'transform: csr=false omit still emits one island metadata',
		omit!.islands.length === 1,
		`count=${omit?.islands.length}`
	);
}

// ---------- Transform: `.ts` registry — mixed region:raw + wake:, held vs placed identities ----------
// A `.ts` registry hands components to `region()` (raw) OR to a renderer that PLACES them (wake).
// `region: 'raw'` → a bare HELD descriptor (server:true, plain object). `wake:` → a HELD binding that is
// ALSO MOUNTABLE (server:true + held, the wrapper with metadata Object.assign'd on): placeable via
// `<svelte:component>` yet still crossable via `region()`. Both mixed in one file, plus dedupe and the
// held-vs-placed identity distinction from a `.svelte` island.
{
	const ROOT = '/app';
	const ctx = {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
		devUrlFor: (p: string) => '/@id/' + p,
		visibleMargin: '0px',
		presets: {}
	};
	// `.ts` held ids: strategy 'held', its baked schedule (`region:raw` / `region:visible`).
	const heldIdOf = (rel: string, hydrate?: string) => {
		const options: Record<string, unknown> = {};
		if (hydrate) {
			options.hydrate = hydrate;
			if (hydrate === 'visible') options.hydrateMargin = '0px';
		}
		return regionId(regionIdentity(rel, { strategy: 'held', options }));
	};

	const tsSrc = `import RawX from './X.svelte' with { region: 'raw' };
import WakeX from './X.svelte' with { wake: 'visible' };
import LoadY from './Y.svelte' with { wake: 'load' };
import WakeX2 from './X.svelte' with { wake: 'visible' };
export const registry = [RawX, WakeX, LoadY, WakeX2];
`;
	const rt = transformTsRegions(tsSrc, '/app/src/lib/registry.ts', ctx)!;
	const islands = rt.islands as Array<Record<string, unknown>>;
	const byId = new Map(islands.map((i) => [i.id as string, i]));

	// WakeX + WakeX2 are the same component+schedule → ONE island. Distinct: RawX, WakeX, LoadY.
	check('transform(.ts mixed): three distinct islands (duplicate wake deduped)', islands.length === 3, `count=${islands.length}`);

	const rawX = byId.get(heldIdOf('src/lib/X.svelte'));
	const wakeX = byId.get(heldIdOf('src/lib/X.svelte', 'visible'));
	const loadY = byId.get(heldIdOf('src/lib/Y.svelte', 'load'));

	check(
		'transform(.ts mixed): region:raw → bare held descriptor (plain object, no wrapper)',
		!!rawX &&
			rawX.server === true &&
			String(rawX.bindingSsrSource).includes('export default {') &&
			!String(rawX.bindingSsrSource).includes('Object.assign')
	);
	check(
		'transform(.ts mixed): wake:visible → MOUNTABLE held binding (server:true + held, wrapper)',
		!!wakeX &&
			wakeX.server === true &&
			wakeX.held === true &&
			String(wakeX.bindingSsrSource).includes('Object.assign(__OgygiaWrap') &&
			/__hydrate: "visible"/.test(String(wakeX.bindingSsrSource)) &&
			String(wakeX.wrapperSource).includes('__mode="island"')
	);
	check(
		'transform(.ts mixed): wake:load → mountable held binding (server:true + held)',
		!!loadY && loadY.server === true && loadY.held === true && /__hydrate: "load"/.test(String(loadY.bindingSsrSource))
	);
	// The SAME component marked raw vs wake → two DISTINCT islands, not a collision.
	check('transform(.ts mixed): same component raw vs wake → distinct islands', !!rawX && !!wakeX && rawX.id !== wakeX.id);
	// Both raw and wake rewrite their host import to the leg-split binding module.
	check(
		'transform(.ts mixed): raw + wake imports both rewritten to region binding modules',
		/import RawX from "virtual:ogygia\/region\//.test(rt.code) && /import WakeX from "virtual:ogygia\/region\//.test(rt.code)
	);

	// A `.ts` held+crossable `wake:` island is DISTINCT from a `.svelte` PLACED island of the same
	// component+schedule — one carries a server endpoint (`held:*`), the other does not (`hydrate:*`).
	const svelteHost = `<script>\nimport X from '$lib/X.svelte' with { wake: 'visible' };\n</script>\n<X />`;
	const rh = transformHost(svelteHost, '/app/src/routes/+page.svelte', ctx)!;
	check(
		'transform(.ts↔.svelte): a .ts held wake island ≠ a .svelte placed island (endpoint vs none)',
		!!wakeX && rh.islands[0].id !== wakeX.id && rh.islands[0].server === false,
		`${rh.islands[0]?.id} vs ${wakeX?.id}`
	);
}

// ---------- Browser e2e ----------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto(base + '/portable', { waitUntil: 'networkidle' });

	check('portable page rendered', (await page.locator('[data-portable-page]').count()) === 1);

	const staticBtn = page.locator('[data-static-use] [data-counter] button');
	await staticBtn.waitFor({ timeout: 5000 });
	check('static: SSR count', (await staticBtn.textContent())?.includes('count is 10') ?? false);
	await staticBtn.click();
	check('static: hydrated click', (await staticBtn.textContent())?.includes('count is 11') ?? false);

	const dynBtn = page.locator('[data-dynamic-use] [data-counter] button');
	await dynBtn.waitFor({ timeout: 5000 });
	check(
		'dynamic Comp: SSR count',
		(await dynBtn.textContent())?.includes('count is 20') ?? false
	);
	await dynBtn.click();
	check(
		'dynamic Comp: hydrated click',
		(await dynBtn.textContent())?.includes('count is 21') ?? false
	);

	const listBtns = page.locator('[data-list-use] [data-counter] button');
	check('list: two instances', (await listBtns.count()) === 2);
	await listBtns.nth(0).click();
	await listBtns.nth(1).click();
	check('list[0] interactive', (await listBtns.nth(0).textContent())?.includes('count is 2') ?? false);
	check('list[1] interactive', (await listBtns.nth(1).textContent())?.includes('count is 3') ?? false);

	const entries = await page.evaluate(() => {
		const els = [...document.querySelectorAll('ogygia-region[wake]')];
		return [...new Set(els.map((e) => e.getAttribute('entry')).filter(Boolean))];
	});
	check('shared entry URL across Counter instances', entries.length === 1, entries.join(', '));

	await page
		.waitForSelector('[data-defer-use] [data-greeting], [data-portable-fallback]', {
			timeout: 5000
		})
		.catch(() => {});
	const greeted = (await page.locator('[data-defer-use]').textContent()) || '';
	check(
		'fill: fallback or greeting present',
		/loading greeting|Portable/i.test(greeted),
		greeted.slice(0, 80)
	);

	await page.close();
} catch (e) {
	check('portable browser suite', false, (e as Error).message.slice(0, 160));
} finally {
	await browser.close();
}

// ---------- Client build: Counter facade dedupe (Rolldown thin facades) ----------
{
	const clientDir = path.join(
		repo,
		'apps/playground',
		'.svelte-kit',
		'output',
		'client',
		'_app',
		'immutable'
	);
	const depsPath = path.join(repo, 'apps/playground', '.svelte-kit', 'og-region-deps.json');
	if (!fs.existsSync(clientDir)) {
		check('build: playground client present (run playground build)', false);
	} else {
		const marker = 'data-counter';
		/** Resolve relative import paths under clientDir. */
		const resolveImp = (fromFile: string, spec: string) => {
			if (spec.startsWith('/')) {
				const trimmed = spec.replace(/^\/_app\/immutable\//, '');
				return trimmed;
			}
			const baseDir = path.posix.dirname(fromFile.split(path.sep).join('/'));
			const joined = path.posix.normalize(
				spec.startsWith('.') ? path.posix.join(baseDir, spec) : spec
			);
			return joined.replace(/^\.\//, '');
		};
		const reaches = (rel: string, seen = new Set<string>()): boolean => {
			const key = rel.split(path.sep).join('/');
			if (seen.has(key)) return false;
			seen.add(key);
			const abs = path.join(clientDir, key);
			if (!fs.existsSync(abs)) return false;
			const code = fs.readFileSync(abs, 'utf-8');
			if (code.includes(marker)) return true;
			for (const m of code.matchAll(/from\s*["']([^"']+)["']/g)) {
				if (reaches(resolveImp(key, m[1]), seen)) return true;
			}
			return false;
		};
		const facades = fs
			.readdirSync(clientDir)
			.filter((f) => f.startsWith('og-region.') && f.endsWith('.js'));
		const counterFacades = facades.filter((f) => reaches(f));
		// Portable page shares one wake:load Counter entry; other routes may add more
		// strategies for Counter — assert the portable shared URL exists once, and component
		// body is not fan-out duplicated across many chunks.
		check(
			'build: at least one Counter-reaching island facade',
			counterFacades.length >= 1,
			String(counterFacades.length)
		);

		// Classic thin Rolldown entry: `import{t as e}from"./chunks/…";export{e as default}`.
		// Triggered when authored component JS is also in another client graph (0.4.1 FOUC, or
		// csr=true __component). csr=false FOUC is CSS-only — islands unique to csr=false stay fat.
		// Counter is also on /kit (csr=true) so its entries may still be thin; assert a csr=false-only
		// marker stays fat instead.
		const classicThin = (code: string) =>
			/^import\{[^}]+\}from"\.\/chunks\/[^"]+";(var [^=]+=[^;]+;)?export\{[^}]+as default\};?$/.test(
				code.trim()
			);
		const reachesMarker = (rel: string, marker: string, seen = new Set<string>()): boolean => {
			const key = rel.split(path.sep).join('/');
			if (seen.has(key)) return false;
			seen.add(key);
			const abs = path.join(clientDir, key);
			if (!fs.existsSync(abs)) return false;
			const code = fs.readFileSync(abs, 'utf-8');
			if (code.includes(marker)) return true;
			for (const m of code.matchAll(/from\s*["']([^"']+)["']/g)) {
				if (reachesMarker(resolveImp(key, m[1]), marker, seen)) return true;
			}
			return false;
		};
		const clockFacades = facades.filter((f) => reachesMarker(f, 'data-clock-island'));
		const thinClocks = clockFacades.filter((f) =>
			classicThin(fs.readFileSync(path.join(clientDir, f), 'utf-8'))
		);
		check(
			'build: csr=false-only clock island is not a classic thin re-export facade',
			clockFacades.length >= 1 && thinClocks.length === 0,
			`clock=${clockFacades.length} thin=${thinClocks.join(', ') || '0'}`
		);

		// Docs (when built): the whole-site chrome now DOGFOODS the ogygia `Shell` — the bespoke
		// SideNav was retired ("ONE Shell for the whole site"). Shell is a plain layout component, not
		// an island, so there is no island facade to assert. What still matters is FOUC: the Shell's
		// scoped chrome CSS must land in the layout stylesheet, or the nav flashes unstyled on first
		// paint. `.og-shell` / `.og-cside` are Shell's stable chrome hooks (see ogygia/shell.css).
		const docsClient = path.join(
			repo,
			'apps/docs',
			'.svelte-kit',
			'output',
			'client',
			'_app',
			'immutable'
		);
		if (fs.existsSync(docsClient)) {
			// Since the playground merge the ROOT layout is import-free (node 0 has no css at
			// all); the docs chrome lives with the `(docs)` group layout, so the Shell rules must
			// land in SOME numbered layout/node stylesheet Kit links for docs pages.
			const assetsDir = path.join(docsClient, 'assets');
			const nodeCss = fs.existsSync(assetsDir)
				? fs.readdirSync(assetsDir).filter((f) => /^\d+\..*\.css$/.test(f))
				: [];
			const shellCss = nodeCss.find((f) => {
				const code = fs.readFileSync(path.join(assetsDir, f), 'utf-8');
				return /\.og-shell\b/.test(code) && /\.og-cside\b/.test(code);
			});
			check(
				'build: docs layout CSS carries the ogygia Shell chrome rules (FOUC)',
				!!shellCss,
				shellCss || `missing (checked ${nodeCss.length} node css files)`
			);
		}

		const chunksWithMarker: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const f = path.join(d, e.name);
				if (e.isDirectory()) walk(f);
				else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(marker)) {
					chunksWithMarker.push(path.relative(clientDir, f));
				}
			}
		};
		walk(clientDir);
		// Two worlds, one copy each (`?og-region` identity): the island world dedupes to ONE chunk
		// (all islands share it), while a csr=true route node (/kit keeps __component) carries its
		// own Kit-world copy — same file, real `$app/*`, hydrated by Kit. Under the old shared
		// identity that node's Counter got whichever `$app/*` flavor won the build-order race.
		// csr=false nodes never ship island imports (asserted below), so nodes/ copies are only
		// ever csr=true pages' own.
		const isleCopies = chunksWithMarker.filter((f) => !f.startsWith('nodes/'));
		const nodeCopies = chunksWithMarker.filter((f) => f.startsWith('nodes/'));
		check(
			'build: Counter marker in exactly one island-world chunk',
			isleCopies.length === 1,
			`island: ${isleCopies.join(', ') || '(none)'}${nodeCopies.length ? ` | csr=true nodes: ${nodeCopies.join(', ')}` : ''}`
		);

		// csr=false scale: hosts under the default layout must not statically import island
		// modules (kit page at /kit is csr=true and intentionally keeps __component).
		const nodesDir = path.join(clientDir, 'nodes');
		const appEntry = fs
			.readdirSync(path.join(clientDir, 'entry'))
			.find((f) => f.startsWith('app.') && f.endsWith('.js'));
		if (fs.existsSync(nodesDir) && appEntry) {
			const appCode = fs.readFileSync(path.join(clientDir, 'entry', appEntry), 'utf-8');
			// Kit client dictionary embeds `"/kit":[25]` (csr=true coexistence demo).
			const csrTrueNodes = new Set<string>();
			for (const m of appCode.matchAll(/"\/kit":\[(\d+)/g)) {
				csrTrueNodes.add(m[1]);
			}
			// A raw-binding client leg is metadata-only: it CONTAINS `__module: "…og-region.x.js"`
			// as a plain string (a registry node, e.g. /blocks). That's fine — the invariant is no
			// static/dynamic IMPORT of an island or wrapper module (dual ownership), so match import
			// syntax, not bare mentions of the filename.
			const island_import_re =
				/(?:from\s*|import\s*\(?\s*)["'][^"']*og-region\.|virtual:ogygia\/(?:wrapper|island)\//;
			const bad: string[] = [];
			for (const f of fs.readdirSync(nodesDir).filter((n) => n.endsWith('.js'))) {
				const nodeNum = f.split('.')[0];
				if (csrTrueNodes.has(nodeNum)) continue; // csr=true coexistence keeps wrapper link
				const code = fs.readFileSync(path.join(nodesDir, f), 'utf-8');
				if (island_import_re.test(code)) {
					bad.push(f);
				}
			}
			check(
				'build: csr=false client nodes omit island/wrapper static imports',
				bad.length === 0,
				bad.join(', ') || 'ok'
			);
			const portableNode = [...appCode.matchAll(/"\/\(spa\)\/portable":\[(\d+)/g)].map(
				(m) => m[1]
			)[0];
			if (portableNode) {
				const pf = fs.readdirSync(nodesDir).find((n) => n.startsWith(portableNode + '.'));
				const pcode = pf ? fs.readFileSync(path.join(nodesDir, pf), 'utf-8') : '';
				check(
					'build: portable (csr=false) node has no island static import',
					!!pf && !island_import_re.test(pcode),
					pf || 'missing'
				);
			}
		} else {
			check('build: client nodes + app entry present', false);
		}

		if (fs.existsSync(depsPath)) {
			const deps = JSON.parse(fs.readFileSync(depsPath, 'utf-8')) as {
				js: Record<string, string[]>;
				css: Record<string, string[]>;
			};
			const portableEntry = '/_app/immutable/og-region.' +
				(counterFacades[0]?.match(/og-region\.([0-9a-f]+)\.js/)?.[1] ?? '') +
				'.js';
			// Presence of deps handoff proves generateBundle walked Rolldown OutputChunk.imports.
			// Shape is `{ js: { entry: [...] }, css: { entry: [...] } }`.
			const jsKeys = Object.keys(deps.js ?? {});
			check(
				'build: island-deps handoff exists (Rolldown generateBundle)',
				jsKeys.some((k) => k.includes('og-region.')),
				`${jsKeys.length} js entries, ${Object.keys(deps.css ?? {}).length} css entries`
			);
			void portableEntry;
		}
	}
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PORTABLE BINDING CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
