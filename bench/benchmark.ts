#!/usr/bin/env node
// Measures each framework's interactive-blog build and prints the comparison tables.
//
// For every framework × post it collects:
//   - JS payload the page loads (uncompressed + gzip -9), summed across all script requests
//   - HTML size (uncompressed + gzip -9)
//   - DOM element count
//   - Lighthouse (mobile, simulated throttling): performance score, LCP, CLS, TBT, script eval
// then averages the Lighthouse metrics across posts and prints a condensed + a full table.
//
// A framework target is either a static build dir (`dist`, served locally) or an
// already-running server (`url`). Missing/unreachable targets are skipped with a note.
//
// Usage:  node benchmark.mjs [--config frameworks.config.json] [--out results/results.md]
//                            [--posts post1,post3] [--json results/results.json] [--gzip]
//                            [--skip astro,iles]
//
// --skip drops framework targets by name (case-insensitive, comma-separated) before the run —
// e.g. `--skip astro,iles` to focus on a subset without editing the config. It's additive: the
// implicit "skip when a target's build/server is missing" behaviour is unchanged.
// Requires: Chrome/Chromium (set CHROME_PATH if not auto-detected), and `npm install`.
//
// --gzip makes the run use Content-Encoding: gzip; without it, everything is served
// uncompressed (`identity`). This matters a lot: under Lighthouse's simulated throttling, LCP is
// dominated by transfer bytes / link bandwidth, so serving uncompressed roughly doubles every
// LCP and penalizes the JS-heaviest frameworks most. The JS/HTML size columns are unaffected —
// they always report decoded bytes plus a gzip -9 of them, so they stay comparable across modes.
//
// The encoding is chosen on the *client* side: Chrome is pinned to one Accept-Encoding for the
// whole run, and every server — the dirs this script serves and a `url` target's own server —
// negotiates against it. That keeps a server-based target honest without needing to configure
// it to match; e.g. Mochi's compress() middleware would default to brotli, but never sees it
// offered. Each target's actual Content-Encoding is still probed and reported, and a run where
// they disagree is flagged rather than quietly published.

import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';

const ROOT = dirname(fileURLToPath(import.meta.url));
const KB = (n) => n / 1024;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const fwId = (fw) => fw.id ?? fw.name;
const fwApproach = (fw) => fw.approach ?? fw.model;

function parseArgs(argv) {
	const args = { config: 'frameworks.config.json' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--config') args.config = argv[++i];
		else if (a === '--out') args.out = argv[++i];
		else if (a === '--json') {
			const next = argv[i + 1];
			if (next && !next.startsWith('--')) args.json = argv[++i];
			else args.json = true;
		} else if (a === '--posts') args.posts = argv[++i].split(',');
		else if (a === '--skip') args.skip = argv[++i].split(',');
		else if (a === '--gzip') args.gzip = true;
		else if (a === '--skip-fidelity') args.skipFidelity = true;
	}
	return args;
}

const COMPRESSIBLE = /^(text\/|application\/json$|image\/svg)|javascript/;

// Static file server with SSG-style path resolution (/x, /x/, /x.html, /x/index.html).
// Compresses whenever the client asks for gzip — same contract as any real server (and as
// Mochi's compress() middleware). Which encoding is actually used is therefore decided by the
// client, not here: see ACCEPT_ENCODING below.
function serveDir(root) {
	const tryFiles = (p) => {
		const c = [];
		if (p === '/') c.push('/index.html');
		else if (p.endsWith('/')) c.push(p + 'index.html', p.slice(0, -1) + '.html');
		else c.push(p, p + '.html', p + '/index.html');
		return c;
	};
	const server = createServer((req, res) => {
		const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		for (const rel of tryFiles(pathname)) {
			const file = join(root, rel);
			if (existsSync(file) && statSync(file).isFile()) {
				const type = MIME[extname(file)] ?? 'application/octet-stream';
				const headers = { 'content-type': type };
				let body = readFileSync(file);
				if (COMPRESSIBLE.test(type) && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
					body = gzipSync(body, { level: 6 }); // 6 = what nginx/CDNs actually ship
					headers['content-encoding'] = 'gzip';
					headers.vary = 'Accept-Encoding';
				}
				headers['content-length'] = body.length;
				res.writeHead(200, headers);
				res.end(body);
				return;
			}
		}
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

// Sizes are always reported decoded + brotli, independent of how the server serves them,
// so the size columns stay comparable between --gzip and plain runs. `identity` keeps the
// server from compressing so `raw` is the true uncompressed size.
async function fetchSizes(url) {
	const res = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
	const buf = Buffer.from(await res.arrayBuffer());
	return { raw: buf.length, br: brotliCompressSync(buf).length };
}

// What did this target actually put on the wire? Ask with the same Accept-Encoding Lighthouse
// uses, so this reports what the measured run really got rather than a different negotiation.
function detectEncoding(url, acceptEncoding) {
	return new Promise((resolve) => {
		const req = httpGet(url, { headers: { 'accept-encoding': acceptEncoding } }, (res) => {
			resolve(res.headers['content-encoding'] ?? 'identity');
			res.resume();
		});
		req.on('error', () => resolve('unknown'));
		req.setTimeout(3000, () => { req.destroy(); resolve('unknown'); });
	});
}

async function runLighthouse(url, chromePort, acceptEncoding) {
	// Pin Chrome's Accept-Encoding so every target — the dirs we serve and the servers we don't —
	// negotiates the same encoding. This is what keeps a `url` target (Mochi, whose compress()
	// middleware would otherwise pick brotli) on the same footing as the static ones.
	const runner = await lighthouse(url, {
		port: chromePort,
		output: 'json',
		logLevel: 'error',
		onlyCategories: ['performance'],
		extraHeaders: { 'Accept-Encoding': acceptEncoding }
	});
	const a = runner.lhr.audits;
	const num = (k) => (a[k] && a[k].numericValue != null ? a[k].numericValue : null);
	const scripts = (a['network-requests']?.details?.items ?? [])
		.filter((i) => i.resourceType === 'Script')
		.map((i) => i.url);

	// Time the main thread spends on JS (evaluation + parse/compile), summed over all scripts.
	// Unlike TBT this isn't windowed between FCP and TTI, so it stays meaningful when the two
	// coincide — which they do here, leaving TBT at 0 for most rows despite real hydration work.
	const boot = a['bootup-time']?.details?.items ?? [];
	const evalMs = boot.reduce((s, i) => s + (i.scripting ?? 0) + (i.scriptParseCompile ?? 0), 0);

	return {
		score: Math.round((runner.lhr.categories.performance.score ?? 0) * 100),
		lcp: num('largest-contentful-paint'),
		cls: num('cumulative-layout-shift'),
		tbt: num('total-blocking-time'),
		// Lighthouse 13 renamed `dom-size` -> `dom-size-insight`; keep the old id as a fallback
		// so this doesn't silently go null again on an older Lighthouse.
		dom: num('dom-size-insight') ?? num('dom-size'),
		evalMs,
		scripts: [...new Set(scripts)]
	};
}

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const kb1 = (n) => KB(n).toFixed(1);

async function bootFramework(fw) {
	if (fw.url) {
		try {
			await fetch(fw.url, { signal: AbortSignal.timeout(3000) });
		} catch {
			return null;
		}
		return { base: fw.url.replace(/\/$/, ''), handle: null };
	}
	const distPath = resolve(ROOT, fw.dist);
	if (!existsSync(distPath)) return null;
	const handle = await serveDir(distPath);
	return { base: `http://127.0.0.1:${handle.port}`, handle };
}

function normalizeProse(html) {
	let s = html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<link\b[^>]*>/gi, '');
	s = s.replace(
		/<button\b[^>]*class=["'][^"']*bench-counter[^"']*["'][^>]*>[\s\S]*?<\/button>/gi,
		'[[COUNTER]]'
	);
	s = s.replace(/<\/?(h[12])\b[^>]*>/gi, (_, t) => (t.startsWith('/') ? `</${t}>` : `<${t}>`));
	s = s.replace(/<[^>]+>/g, ' ');
	return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function countCounters(html) {
	const m = html.match(/class=["'][^"']*bench-counter[^"']*["']/gi);
	return m ? m.length : 0;
}

function headingSkeleton(html) {
	const out = [];
	const re = /<(h[12])\b[^>]*>([\s\S]*?)<\/\1>/gi;
	let m;
	while ((m = re.exec(html))) {
		const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
		out.push(`${m[1]}:${text}`);
	}
	return out.join('|');
}

async function fidelityCheck(frameworks, posts, outPath) {
	const lines = [
		'# Fidelity preflight',
		'',
		'Every framework must render the same prose, heading structure, and exactly 5 `.bench-counter` widgets per post.',
		''
	];
	let ok = true;
	const booted = [];
	for (const fw of frameworks) {
		const b = await bootFramework(fw);
		if (!b) {
			lines.push(`- **${fwId(fw)}**: SKIP (unreachable / missing dist)`);
			continue;
		}
		booted.push({ fw, ...b });
	}
	for (const post of posts) {
		lines.push(`## ${post.id}`, '');
		const samples = new Map();
		for (const { fw, base } of booted) {
			let html = '';
			try {
				const res = await fetch(base + post.path, { headers: { 'accept-encoding': 'identity' } });
				html = await res.text();
			} catch (e) {
				lines.push(`- **${fwId(fw)}**: FAIL fetch — ${e?.message ?? e}`);
				ok = false;
				continue;
			}
			const counters = countCounters(html);
			const prose = normalizeProse(html);
			const headings = headingSkeleton(html);
			samples.set(fwId(fw), { prose, counters, headings });
			if (counters !== 5) ok = false;
			lines.push(
				`- **${fwId(fw)}**: counters=${counters}${counters === 5 ? '' : ' (expected 5)'} · prose chars=${prose.length} · headings=${headings.split('|').filter(Boolean).length}`
			);
		}
		const ids = [...samples.keys()];
		if (ids.length >= 2) {
			const ref = samples.get(ids[0]);
			for (const id of ids.slice(1)) {
				const s = samples.get(id);
				if (s.counters !== ref.counters) {
					lines.push(`- ✗ counter count mismatch: ${ids[0]}=${ref.counters} vs ${id}=${s.counters}`);
					ok = false;
				}
				if (s.headings !== ref.headings) {
					lines.push(`- ✗ heading structure mismatch: ${ids[0]} vs ${id}`);
					ok = false;
				}
				if (s.prose !== ref.prose) {
					const ratio = Math.abs(s.prose.length - ref.prose.length) / Math.max(ref.prose.length, 1);
					if (ratio > 0.02) {
						lines.push(
							`- ✗ prose mismatch: ${ids[0]} (${ref.prose.length}) vs ${id} (${s.prose.length}) — ${(ratio * 100).toFixed(1)}% length drift`
						);
						ok = false;
					} else {
						lines.push(`- ~ prose near-match ${ids[0]} vs ${id} (${(ratio * 100).toFixed(2)}% length drift — OK)`);
					}
				} else {
					lines.push(`- ✓ ${ids[0]} ≡ ${id} (prose + headings + counters)`);
				}
			}
		}
		lines.push('');
	}
	for (const { handle } of booted) handle?.server.close();
	lines.push(ok ? '**PASS**' : '**FAIL** — refusing to publish numbers.');
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, lines.join('\n') + '\n');
	console.error(`Wrote ${outPath}`);
	return ok;
}

async function measureFramework(fw, posts, chromePort, opts = {}) {
	const booted = await bootFramework(fw);
	if (!booted) {
		if (fw.url) console.error(`  ! skipping ${fwId(fw)}: ${fw.url} not reachable (start its server first)`);
		else console.error(`  ! skipping ${fwId(fw)}: dist not found at ${fw.dist} (build it first)`);
		return null;
	}
	const { base, handle } = booted;

	const encoding = await detectEncoding(base + posts[0].path, opts.acceptEncoding);

	const rows = [];
	for (const post of posts) {
		const url = base + post.path;
		process.stderr.write(`  ${fwId(fw)} ${post.id} … `);
		const lh = await runLighthouse(url, chromePort, opts.acceptEncoding);
		const html = await fetchSizes(url);
		let jsRaw = 0, jsBr = 0;
		for (const s of lh.scripts) {
			const { raw, br } = await fetchSizes(s);
			jsRaw += raw;
			jsBr += br;
		}
		rows.push({ post: post.id, words: post.words, jsRaw, jsBr, htmlRaw: html.raw, htmlBr: html.br, ...lh });
		console.error(`score ${lh.score}, LCP ${Math.round(lh.lcp)}ms, TBT ${Math.round(lh.tbt)}ms, eval ${Math.round(lh.evalMs)}ms, JS ${kb1(jsBr)}KB br`);
	}
	handle?.server.close();

	const dom = rows.map((r) => r.dom).filter((d) => d != null);
	return {
		id: fwId(fw),
		name: fwId(fw),
		approach: fwApproach(fw),
		model: fwApproach(fw),
		encoding,
		rows,
		avg: {
			score: Math.round(avg(rows.map((r) => r.score))),
			lcp: Math.round(avg(rows.map((r) => r.lcp))),
			cls: avg(rows.map((r) => r.cls)),
			tbt: Math.round(avg(rows.map((r) => r.tbt))),
			evalMs: Math.round(avg(rows.map((r) => r.evalMs))),
			dom: dom.length ? Math.round(avg(dom)) : null
		}
	};
}

function jsCell(rows) {
	const br = rows.map((r) => Math.round(KB(r.jsBr)));
	const flat = br.every((v) => v === br[0]);
	return flat ? `${br[0]} KB (flat)` : `${br[0]} → ${br[br.length - 1]} KB`;
}
function htmlRange(rows) {
	const br = rows.map((r) => Math.round(KB(r.htmlBr)));
	return `${br[0]} → ${br[br.length - 1]} KB`;
}

function condensedTable(results) {
	const l = [
		'| Framework | Approach | JS brotli | HTML brotli | Avg score | Avg LCP | Avg TBT | Avg JS eval |',
		'|---|---|---|---|---|---|---|---|'
	];
	for (const r of results)
		l.push(`| **${r.id}** | ${r.approach} | ${jsCell(r.rows)} | ${htmlRange(r.rows)} | ${r.avg.score} | ${(r.avg.lcp / 1000).toFixed(1)} s | ${r.avg.tbt} ms | ${r.avg.evalMs} ms |`);
	return l.join('\n');
}

function fullTable(results, posts) {
	const head = ['Framework', 'Approach', 'Served', ...posts.map((p) => `JS ${p.id}`), ...posts.map((p) => `HTML ${p.id}`), 'Avg score', 'Avg LCP', 'Avg CLS', 'Avg TBT', 'Avg JS eval', 'Avg DOM'];
	const l = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
	for (const r of results) {
		const js = r.rows.map((x) => `${kb1(x.jsRaw)} / ${kb1(x.jsBr)}`);
		const html = r.rows.map((x) => `${kb1(x.htmlRaw)} / ${kb1(x.htmlBr)}`);
		l.push(`| **${r.id}** | ${r.approach} | ${r.encoding} | ${js.join(' | ')} | ${html.join(' | ')} | ${r.avg.score} | ${r.avg.lcp} ms | ${r.avg.cls.toFixed(3)} | ${r.avg.tbt} ms | ${r.avg.evalMs} ms | ${r.avg.dom ?? 'n/a'} |`);
	}
	return l.join('\n');
}

/**
 * Chrome for Lighthouse: honour `CHROME_PATH`, else fall back to Playwright's bundled Chromium (it is
 * already installed for the verify suite), else let chrome-launcher search the system. Keeps
 * `npm run bench` working without a separate system Chrome install.
 */
async function resolveChromePath() {
	if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
	try {
		const { chromium } = await import('playwright');
		const p = chromium.executablePath();
		if (p) return p;
	} catch {
		/* playwright absent — chrome-launcher will search the system */
	}
	return undefined;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cfg = JSON.parse(readFileSync(resolve(ROOT, args.config), 'utf8'));
	const posts = args.posts ? cfg.posts.filter((p) => args.posts.includes(p.id)) : cfg.posts;

	const skip = new Set((args.skip ?? []).map((s) => s.toLowerCase()));
	const frameworks = cfg.frameworks.filter((fw) => !skip.has(fwId(fw).toLowerCase()));

	const acceptEncoding = args.gzip ? 'gzip' : 'identity';

	if (!args.skipFidelity) {
		console.error('▸ fidelity preflight');
		const fidelityOk = await fidelityCheck(frameworks, posts, resolve(ROOT, 'results/fidelity.md'));
		if (!fidelityOk) {
			console.error('\nFidelity failed — not publishing numbers. Fix apps or pass --skip-fidelity.');
			process.exit(1);
		}
	}

	const chrome = await launch({
		chromePath: await resolveChromePath(),
		chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
	});

	const results = [];
	try {
		for (const fw of frameworks) {
			const r = await measureFramework(fw, posts, chrome.port, { acceptEncoding });
			if (r) results.push(r);
		}
	} finally {
		await chrome.kill();
	}

	if (!results.length) {
		console.error('\nNo frameworks measured. Build the static ones and/or start the server ones, then retry.');
		process.exit(1);
	}

	const encodings = [...new Set(results.map((r) => r.encoding))];
	const mixed = encodings.length > 1;
	if (mixed) {
		console.error(`\n  ! WARNING: targets did not all use the same content-encoding: ${results.map((r) => `${r.id}=${r.encoding}`).join(', ')}`);
		console.error('    LCP scales with transfer bytes, so these rows are not directly comparable.');
	}

	const md = [
		'# ogygiaBench results', '',
		'> Port of [khromov/interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark). Credit [@khromov](https://github.com/khromov).', '',
		'## Condensed', '', condensedTable(results), '',
		'- **JS brotli** = brotli JS the page loads. *flat* = identical on all posts (islands); `→` = first → last-post growth.',
		'- HTML ≈ identical across frameworks (same prose). Prefer **Avg JS eval** over TBT here.', '',
		'## Full (JS / HTML shown as uncompressed / brotli KB)', '', fullTable(results, posts), '',
		mixed ? `> ⚠️ **Mixed content-encoding across targets** (${results.map((r) => `${r.id}: ${r.encoding}`).join(', ')}). LCP scales with transfer bytes, so these rows are not directly comparable.\n` : '',
		`_Lighthouse, mobile + simulated throttling, HTTP/1.1, content-encoding: ${encodings.join(' + ')}. Generated by \`benchmark.mjs\`${args.gzip ? ' --gzip' : ''}._`
	].join('\n');

	console.log('\n' + md + '\n');
	if (args.out) {
		mkdirSync(dirname(resolve(ROOT, args.out)), { recursive: true });
		writeFileSync(resolve(ROOT, args.out), md + '\n');
		console.error(`Wrote ${args.out}`);
	}
	if (args.json) {
		const jsonPath =
			args.json === true
				? args.out
					? resolve(ROOT, args.out).replace(/\.md$/i, '.json')
					: resolve(ROOT, 'results/latest.json')
				: resolve(ROOT, args.json);
		mkdirSync(dirname(jsonPath), { recursive: true });
		// Docs-clean shape: rounded numbers, no ephemeral script URLs. Rendered directly by the docs
		// perf page (charts). `br` everywhere is brotli bytes; sizes in bytes, times in ms.
		const clean = {
			generatedWith: 'benchmark.ts (port of khromov/interactive-blogs-benchmark)',
			posts: posts.map((p) => ({ id: p.id, words: p.words })),
			frameworks: results.map((f) => ({
				id: f.id,
				approach: f.approach,
				rows: f.rows.map((r) => ({
					post: r.post,
					words: r.words,
					jsRaw: r.jsRaw,
					jsBr: r.jsBr,
					htmlRaw: r.htmlRaw,
					htmlBr: r.htmlBr,
					score: r.score,
					lcp: Math.round(r.lcp),
					cls: Number(r.cls.toFixed(3)),
					tbt: Math.round(r.tbt),
					evalMs: Math.round(r.evalMs),
					dom: r.dom
				})),
				avg: {
					score: f.avg.score,
					lcp: f.avg.lcp,
					cls: Number(f.avg.cls.toFixed(3)),
					tbt: f.avg.tbt,
					evalMs: f.avg.evalMs,
					dom: f.avg.dom
				}
			}))
		};
		writeFileSync(jsonPath, JSON.stringify(clean, null, 2) + '\n');
		console.error(`Wrote ${jsonPath}`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
