// Portable island bindings (0.4.0): marked imports are values — static tag, svelte:component,
// and each/list share one entry module. csr=false client hosts omit wrappers (scale).
// Usage: node verify/portable-bindings.ts [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	transformHost,
	regionIdentity,
	regionId,
	CLIENT_BINDING_STUB
} from '../packages/ogygia/dist/vite/transform.js';

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
import A from './A.svelte' with { hydrate: 'load' };
import B from './A.svelte' with { hydrate: 'load' };
const dyn = A;
const list = [{ comp: A, props: { n: 1 } }, { comp: B, props: { n: 2 } }];
</script>
<A n={1} />
<A n={2} />
<svelte:component this={dyn} n={3} />
{#each list as item}<svelte:component this={item.comp} {...item.props} />{/each}
`;
	const r = transformHost(src, HOST, ctx);
	check(
		'transform: portable rewrite keeps host tags as A/B',
		!!r && /import A from "virtual:ogygia\/wrapper\//.test(r.code)
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
		'transform: svelte:component + each allowed (no static-tag error)',
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
		'svelte:component: SSR count',
		(await dynBtn.textContent())?.includes('count is 20') ?? false
	);
	await dynBtn.click();
	check(
		'svelte:component: hydrated click',
		(await dynBtn.textContent())?.includes('count is 21') ?? false
	);

	const listBtns = page.locator('[data-list-use] [data-counter] button');
	check('list: two instances', (await listBtns.count()) === 2);
	await listBtns.nth(0).click();
	await listBtns.nth(1).click();
	check('list[0] interactive', (await listBtns.nth(0).textContent())?.includes('count is 2') ?? false);
	check('list[1] interactive', (await listBtns.nth(1).textContent())?.includes('count is 3') ?? false);

	const entries = await page.evaluate(() => {
		const els = [...document.querySelectorAll('ogygia-region[hydrate]')];
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
		'defer: fallback or greeting present',
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
		'playground',
		'.svelte-kit',
		'output',
		'client',
		'_app',
		'immutable'
	);
	const depsPath = path.join(repo, 'playground', '.svelte-kit', 'ogygia-island-deps.json');
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
			.filter((f) => f.startsWith('ogygia-island.') && f.endsWith('.js'));
		const counterFacades = facades.filter((f) => reaches(f));
		// Portable page shares one hydrate:load Counter entry; other routes may add more
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

		// Docs (when built): SideNav must own its entry + CSS must land in layout stylesheet.
		const docsClient = path.join(
			repo,
			'docs',
			'.svelte-kit',
			'output',
			'client',
			'_app',
			'immutable'
		);
		if (fs.existsSync(docsClient)) {
			const docsFacades = fs
				.readdirSync(docsClient)
				.filter((f) => f.startsWith('ogygia-island.') && f.endsWith('.js'));
			const sideNav = docsFacades.find((f) => {
				const code = fs.readFileSync(path.join(docsClient, f), 'utf-8');
				if (code.includes('side-backdrop') || code.includes('1il4ztj')) return true;
				for (const m of code.matchAll(/from\s*["']\.\/chunks\/([^"']+)["']/g)) {
					const ch = path.join(docsClient, 'chunks', m[1]);
					if (
						fs.existsSync(ch) &&
						/side-backdrop|1il4ztj/.test(fs.readFileSync(ch, 'utf-8'))
					) {
						return true;
					}
				}
				return false;
			});
			const sideNavCode = sideNav
				? fs.readFileSync(path.join(docsClient, sideNav), 'utf-8')
				: '';
			check(
				'build: docs SideNav island is not a classic thin re-export facade',
				!!sideNav && !classicThin(sideNavCode.trim()),
				sideNav || 'missing'
			);
			const layoutCss = fs.existsSync(path.join(docsClient, 'assets'))
				? fs
						.readdirSync(path.join(docsClient, 'assets'))
						.find((f) => /^0\..*\.css$/.test(f))
				: null;
			const layoutCssCode = layoutCss
				? fs.readFileSync(path.join(docsClient, 'assets', layoutCss), 'utf-8')
				: '';
			check(
				'build: docs layout CSS includes SideNav scoped rules (FOUC)',
				!!layoutCss && /side-backdrop|1il4ztj|--side-w/.test(layoutCssCode),
				layoutCss || 'missing'
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
		check(
			'build: Counter marker in exactly one chunk (not N copies)',
			chunksWithMarker.length === 1,
			chunksWithMarker.join(', ') || '(none)'
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
			const bad: string[] = [];
			for (const f of fs.readdirSync(nodesDir).filter((n) => n.endsWith('.js'))) {
				const nodeNum = f.split('.')[0];
				if (csrTrueNodes.has(nodeNum)) continue; // csr=true coexistence keeps wrapper link
				const code = fs.readFileSync(path.join(nodesDir, f), 'utf-8');
				if (/ogygia-island\.|virtual:ogygia\/(?:wrapper|island)\//.test(code)) {
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
					!!pf && !/ogygia-island\.|virtual:ogygia\/(?:wrapper|island)\//.test(pcode),
					pf || 'missing'
				);
			}
		} else {
			check('build: client nodes + app entry present', false);
		}

		if (fs.existsSync(depsPath)) {
			const deps = JSON.parse(fs.readFileSync(depsPath, 'utf-8')) as Record<string, string[]>;
			const portableEntry = '/_app/immutable/ogygia-island.' +
				(counterFacades[0]?.match(/ogygia-island\.([0-9a-f]+)\.js/)?.[1] ?? '') +
				'.js';
			// Presence of deps handoff proves generateBundle walked Rolldown OutputChunk.imports.
			check(
				'build: island-deps handoff exists (Rolldown generateBundle)',
				Object.keys(deps).some((k) => k.includes('ogygia-island.')),
				`${Object.keys(deps).length} entries`
			);
			void portableEntry;
		}
	}
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PORTABLE BINDING CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
