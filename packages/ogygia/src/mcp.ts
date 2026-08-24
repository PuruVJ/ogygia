/**
 * `ogygia mcp` — a Model Context Protocol server that exposes the REAL ogygia compiler to an AI.
 *
 * The transform runs in plain Node (no browser, no WASM stub — the oxc parser auto-loads), so an AI
 * client (Claude Desktop / Claude Code / any MCP host) can hand ogygia a `.svelte` source and get back
 * the island map, the rewritten host, the wire shape, and any rule violations — the same currency the
 * Observatory shows a human, in a form an AI can reason over.
 *
 * Transport is stdio, newline-delimited JSON-RPC 2.0 (the MCP stdio contract). Hand-rolled on purpose:
 * zero runtime deps beyond ogygia's own compiler, so `npx ogygia mcp` just works wherever ogygia is
 * installed. Everything human-facing goes to STDERR — stdout is the protocol channel and must stay clean.
 *
 * @packageDocumentation
 */
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { parse } from 'svelte/compiler';
import { transformHost, islandVirtualId, wrapperVirtualId, CLIENT_BINDING_STUB } from './compiler/index.js';
import { ogp_decode, is_ogp } from './profiler/crypto.js';
import { report_json, is_dump } from './profiler/report.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ogygia';
const MARK_KEYS = new Set(['wake', 'render', 'region', 'keep', 'preset', 'margin']);

type Attrs = Record<string, unknown>;
type Mark = { local: string; component: string; attrs: Attrs };
type HostIsland = {
	id?: string;
	componentPath?: string;
	kind?: string;
	wrapperPath?: string;
	wrapperSource?: string;
	virtualPath?: string;
	source?: string;
};
type HostResult = { code?: string; islands?: HostIsland[] } | null;

// The Observatory's build_ctx, in Node: real path, no file reads (single-source REPL), dev shape.
function build_ctx(ssr: boolean, route_csr = false) {
	return {
		root: '/repl',
		libDir: '/repl/src/lib',
		readFile: () => null,
		pathModule: path as never,
		dev: true,
		virtualPathFor: (_host: string, iid: string) => islandVirtualId(iid),
		wrapperPathFor: (_host: string, iid: string) => wrapperVirtualId(iid),
		devUrlFor: (virtual: string) => '/@id/' + virtual,
		visibleMargin: undefined,
		presets: {},
		importKeys: undefined,
		idSalt: '',
		linkVirtualIsland: true,
		clientBindingStub: CLIENT_BINDING_STUB,
		routeCsr: route_csr,
		ssr
	};
}

/** Pull the marked imports (`import X from './X.svelte' with { … }`) out of a component's script. */
function parse_marks(source: string): Mark[] {
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(source, { modern: true });
	} catch {
		return [];
	}
	const bodies: Array<Record<string, unknown>> = [];
	const inst = (ast as { instance?: { content?: { body?: unknown[] } } }).instance;
	const mod = (ast as { module?: { content?: { body?: unknown[] } } }).module;
	if (inst?.content?.body) bodies.push(...(inst.content.body as Array<Record<string, unknown>>));
	if (mod?.content?.body) bodies.push(...(mod.content.body as Array<Record<string, unknown>>));

	const marks: Mark[] = [];
	for (const node of bodies) {
		if (node.type !== 'ImportDeclaration') continue;
		const attrs: Attrs = {};
		for (const a of (node.attributes as Array<Record<string, never>>) || []) {
			const key = (a.key as { name?: string; value?: string })?.name ?? (a.key as { value?: string })?.value;
			if (key) attrs[key] = (a.value as { value?: unknown })?.value;
		}
		if (!Object.keys(attrs).some((k) => MARK_KEYS.has(k))) continue;
		const local = (node.specifiers as Array<{ local?: { name?: string } }>)?.[0]?.local?.name ?? '?';
		const component = (node.source as { value: string }).value;
		marks.push({ local, component, attrs });
	}
	return marks;
}

const base = (p?: string) => (p ? p.split('?')[0].split('/').pop() || p : '');

/** A one-line, human/AI-legible label for what a mark's dials make it. */
function strategy_label(attrs: Attrs): string {
	if (attrs.region === 'raw') return 'held region (raw — HTML only, ships no JS)';
	if (attrs.render === 'deferred') return `server island (deferred, fetched on ${attrs.wake ?? 'load'})`;
	if (attrs.render === 'live') return 'live region (baked, revalidates in background)';
	if (attrs.wake === 'none') return 'lake (frozen server HTML, ships no JS)';
	const wake = (attrs.wake as string) ?? 'load';
	return `island (interactive, wakes on ${wake})${attrs.keep ? `, kept across nav as "${attrs.keep}"` : ''}`;
}

type Island = { component: string; local: string; kind: string; strategy: string; attrs: Attrs; id: string };

/** Run the real transform + merge in the marks → the island map an AI can read. Throws are the caller's. */
function compile(source: string, filename: string, ssr: boolean, route_csr: boolean): { code: string; islands: Island[] } {
	const id = `/repl/src/routes/${filename}`;
	const result = transformHost(source, id, build_ctx(ssr, route_csr)) as HostResult;
	const marks = parse_marks(source);
	const list = result?.islands ?? [];
	// Real md5 id + authoritative kind come from transformHost; local + dials come from the marks.
	const real_by_component = new Map<string, HostIsland>();
	for (const isl of list) if (isl.componentPath) real_by_component.set(base(isl.componentPath), isl);
	const islands: Island[] = marks.map((m) => {
		const hit = real_by_component.get(base(m.component));
		return {
			component: m.component,
			local: m.local,
			kind: hit?.kind ?? '(mark only)',
			strategy: strategy_label(m.attrs),
			attrs: m.attrs,
			id: hit?.id ?? ''
		};
	});
	return { code: result?.code ?? source, islands };
}

// ── tools ────────────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

const TOOLS = [
	{
		name: 'ogygia_compile',
		description:
			'Compile a Svelte component through the real ogygia transform (as it runs at build). Returns the ' +
			'island map (which imports became islands, with their render/wake dials and real ids) and the ' +
			'rewritten host module. Use this to see exactly what ogygia does to a component.',
		inputSchema: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'The .svelte component source to compile.' },
				filename: { type: 'string', description: 'File name for ids/errors (default App.svelte).' },
				csr: {
					type: 'boolean',
					description: 'true = compile the csr=true leg (ogygia steps aside, islands stripped to plain). Default false.'
				}
			},
			required: ['source']
		}
	},
	{
		name: 'ogygia_islands',
		description:
			'The island map only (no rewritten code): each marked import → its primitive (island / lake / ' +
			'server island / live / held region), its render+wake dials, and its build id. The fast overview.',
		inputSchema: {
			type: 'object',
			properties: { source: { type: 'string', description: 'The .svelte component source.' } },
			required: ['source']
		}
	},
	{
		name: 'ogygia_check',
		description:
			'Check a component against ogygia rules. Runs the real transform and reports any [ogygia] build ' +
			'error it raises (writing to captured host state, illegal nesting, a non-literal macro argument, an ' +
			'island dynamic-import, …). Use this to validate a component an AI wrote before trusting it.',
		inputSchema: {
			type: 'object',
			properties: { source: { type: 'string', description: 'The .svelte component source to validate.' } },
			required: ['source']
		}
	},
	{
		name: 'ogygia_explain',
		description:
			'Explain, in prose, what happens to each marked component at runtime: where its HTML comes from, ' +
			'when (or whether) its JS runs, and how its props cross the island boundary. The teaching view.',
		inputSchema: {
			type: 'object',
			properties: { source: { type: 'string', description: 'The .svelte component source.' } },
			required: ['source']
		}
	},
	{
		name: 'ogygia_debug',
		description:
			'Debug a REAL running page. Loads a URL of your running ogygia app in a headless browser, lets its ' +
			'islands hydrate (scrolls to trigger `visible` islands; optionally clicks a selector to trigger an ' +
			'`interaction` one), then returns the ACTUAL runtime story per island from the devtools event bus: ' +
			'SSR → wire → connected → woke → hydrated (with timings), plus anomalies (SSR’d-but-never-connected, ' +
			'hydration failures). Requires the app to be a devtools build (OGYGIA_DEVTOOLS=1) and Playwright ' +
			'installed. Use this to see what really happened instead of reasoning from source.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL of a page on the running app (e.g. http://localhost:5173/blog).' },
				wait: { type: 'number', description: 'ms to wait for hydration to settle (default 2500, max 8000).' },
				scroll: { type: 'boolean', description: 'Scroll the page to trigger `visible` islands (default true).' },
				click: { type: 'string', description: 'Optional CSS selector to click, to wake an `interaction` island.' }
			},
			required: ['url']
		}
	},
	{
		name: 'ogygia_profile',
		description:
			'Profile the SERVER-SIDE render of a route. Records N renders through ogygia’s SSR profiler and ' +
			'returns a digest of its analysis: verdict (compute- vs io-bound), render p50, CPU findings, where ' +
			'the time went by category, the hottest functions + components (Svelte names each component after ' +
			'its file), network calls, and heap growth. Requires the app to mount profiler() in hooks.server.ts ' +
			'(the tool tells you how if it is missing). Profile a prod build for real numbers; dev is indicative.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'The route URL to profile (e.g. http://localhost:5173/blog).' },
				runs: { type: 'number', description: 'Profiled renders to record (default 5, max 50). More = steadier median.' },
				key: { type: 'string', description: 'Profiler secret (?key=) — needed only when the app set one (prod).' },
				base: { type: 'string', description: 'Profiler mount path (default /__profiler).' }
			},
			required: ['url']
		}
	},
	{
		name: 'ogygia_profile_open',
		description:
			'Open a downloaded `.ogp` profile and return the same digest as ogygia_profile — verdict, render ' +
			'p50, CPU findings, time-by-category, hottest functions + components, network, heap. A `.ogp` is the ' +
			'encrypted trace you download when a live report can’t be kept (serverless/Amplify evict it, or the ' +
			'browser can’t render it). It decrypts entirely from the FILE — no running server, no profiler ' +
			'login. The file is AES-encrypted with the key it was exported with; pass that as `key`. If you don’t ' +
			'have it, ask the user for the export key and retry. That key is the ONLY thing needed — it is not ' +
			'the app’s profiler secret, and holding the file + its key already authorizes reading it.',
		inputSchema: {
			type: 'object',
			properties: {
				file: { type: 'string', description: 'Path to the .ogp file (absolute, or relative to the MCP server cwd).' },
				key: { type: 'string', description: 'The export key the .ogp was made with. Omit only for a dev-key export; a wrong/absent key fails cleanly and asks for it.' }
			},
			required: ['file']
		}
	},
	{
		name: 'ogygia_scan',
		description:
			'Scan a WHOLE ogygia project: walks a directory for .svelte files, runs the real transform on each, ' +
			'and returns the entire island architecture (every island / lake / server island / held region, by ' +
			'file, with its render+wake dials) PLUS a lint pass — hard [ogygia] errors and soft anti-patterns the ' +
			'transform allows (island-in-island, wake:none+deferred, interaction+deferred). Use it to understand or ' +
			'audit a real app, not one snippet.',
		inputSchema: {
			type: 'object',
			properties: {
				dir: { type: 'string', description: 'Directory to scan, relative to the server cwd or absolute (default "src"; try "src/routes").' }
			}
		}
	},
	{
		name: 'ogygia_observatory',
		description:
			'Bundle one or more files into a shareable, CLIENT-ONLY ogygia Observatory link so the user can see ' +
			'their code compiled + running live in the browser (island map, byte ledger, wire, hydrating preview). ' +
			'The files are gzip-packed into the URL # fragment, which browsers never send to a server — nothing ' +
			'hits any server. Great for showing the user how one of their real pages becomes islands. Pass `files` ' +
			'(a map of filename → source; App.svelte is the entry) or a single `source`.',
		inputSchema: {
			type: 'object',
			properties: {
				files: { type: 'object', description: 'Map of filename → source. App.svelte is the entry; include the components it imports.', additionalProperties: { type: 'string' } },
				source: { type: 'string', description: 'Single-file convenience: the component source (paired with `filename`).' },
				filename: { type: 'string', description: 'Name for `source` (default App.svelte).' },
				base: { type: 'string', description: 'Observatory base URL (default the public docs Observatory; use a localhost URL to target a dev build).' }
			}
		}
	}
];

function tool_compile(args: Attrs): ToolResult {
	const source = String(args.source ?? '');
	const filename = String(args.filename ?? 'App.svelte');
	const csr = args.csr === true;
	if (!source.trim()) return fail('`source` is required.');
	let out: { code: string; islands: Island[] };
	try {
		out = compile(source, filename, true, csr);
	} catch (e) {
		return fail(`[ogygia] transform error:\n${e instanceof Error ? e.message : String(e)}`);
	}
	const map = out.islands.length
		? out.islands.map((i) => `- ${i.component} (as ${i.local}) — ${i.strategy}${i.id ? ` · id ${i.id.slice(0, 8)}` : ''}`).join('\n')
		: '(no marked components — the whole file is free server HTML)';
	const structured = JSON.stringify(
		{ csr, islands: out.islands.map((i) => ({ component: i.component, kind: i.kind, ...i.attrs, id: i.id })) },
		null,
		2
	);
	return text(
		`# ogygia transform — ${filename}${csr ? ' (csr=true leg)' : ''}\n\n` +
			`## Island map (${out.islands.length})\n${map}\n\n` +
			`## Structured\n\`\`\`json\n${structured}\n\`\`\`\n\n` +
			`## Rewritten host module\n\`\`\`js\n${out.code}\n\`\`\``
	);
}

function tool_islands(args: Attrs): ToolResult {
	const source = String(args.source ?? '');
	if (!source.trim()) return fail('`source` is required.');
	let out: { code: string; islands: Island[] };
	try {
		out = compile(source, 'App.svelte', true, false);
	} catch (e) {
		return fail(`[ogygia] transform error:\n${e instanceof Error ? e.message : String(e)}`);
	}
	const structured = out.islands.map((i) => ({ component: i.component, local: i.local, kind: i.kind, ...i.attrs, id: i.id }));
	return text(`${out.islands.length} marked region(s)\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``);
}

function tool_check(args: Attrs): ToolResult {
	const source = String(args.source ?? '');
	if (!source.trim()) return fail('`source` is required.');
	try {
		compile(source, 'App.svelte', true, false);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return text(`❌ FAILS ogygia rules\n\n${msg}`);
	}
	// The client leg can raise its own errors (captured writes surface there); run it too.
	try {
		compile(source, 'App.svelte', false, false);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return text(`❌ FAILS ogygia rules (client leg)\n\n${msg}`);
	}
	return text('✅ passes ogygia rules — the transform accepts this component.');
}

function tool_explain(args: Attrs): ToolResult {
	const source = String(args.source ?? '');
	if (!source.trim()) return fail('`source` is required.');
	let out: { code: string; islands: Island[] };
	try {
		out = compile(source, 'App.svelte', true, false);
	} catch (e) {
		return fail(`[ogygia] transform error:\n${e instanceof Error ? e.message : String(e)}`);
	}
	if (!out.islands.length)
		return text('This component marks nothing, so it ships as pure server HTML — zero JavaScript, no islands.');
	const lines = out.islands.map((i) => {
		const a = i.attrs;
		if (a.region === 'raw') return `• ${i.component}: a held region marked \`raw\` — server picks it, it renders as HTML and ships no JS.`;
		if (a.render === 'deferred')
			return `• ${i.component}: a server island. Its HTML is fetched later from a signed endpoint (on ${a.wake ?? 'load'}); show \`ogygiaFallback\` while it loads. Not interactive unless it nests its own wake island.`;
		if (a.render === 'live') return `• ${i.component}: a live region — baked at request, then revalidated in the background and morphed in place.`;
		if (a.wake === 'none') return `• ${i.component}: a lake — heavy static subtree frozen to server HTML inside an island; ships no JS of its own.`;
		const wake = a.wake ?? 'load';
		const keep = a.keep ? ` It is kept across SPA navigation as "${a.keep}" — its live \`$state\` survives the nav.` : '';
		return `• ${i.component}: an island. Its own hydration root; JS wakes on ${wake}. Props cross by value (devalue) — functions never cross, captured host state is a snapshot.${keep}`;
	});
	return text(`How this page behaves at runtime:\n\n${lines.join('\n')}`);
}

// ── ogygia_debug — the RUNTIME half: drive a headless browser over a real page ─────────────────────

/** One event off `window.__ogygia_devtools` — the fp-correlated devtools stream (schema in devtools/). */
type DtEvent = { name: string; fp?: string; entry?: string; realm?: string; seq?: number; t?: number; [k: string]: unknown };

const short = (fp: string) => fp.slice(0, 8);

/** Turn the raw event stream into a per-island runtime story + invariant warnings an AI can act on. */
function render_story(url: string, events: DtEvent[]): string {
	if (!events.length)
		return `Loaded ${url}, but the devtools bus emitted no events — no islands on this page, or nothing had happened yet.`;

	// Server (SSR) events are stamped with the SERVER process's `performance.now()` — a different clock
	// than the browser's — so relative timing is computed from CLIENT events only; server events just
	// read "SSR'd" with no client-relative ms.
	const client_ts = events.filter((e) => e.realm === 'client').map((e) => Number(e.t ?? 0));
	const t0 = client_ts.length ? Math.min(...client_ts) : Math.min(...events.map((e) => Number(e.t ?? 0)));
	const at = (e: DtEvent) => (e.realm === 'server' ? '' : `+${Math.round(Number(e.t ?? t0) - t0)}ms`);
	const when = (e?: DtEvent) => {
		if (!e) return '';
		const a = at(e);
		return a ? ` (${a})` : '';
	};
	const has = (evs: DtEvent[], n: string) => evs.find((e) => e.name === n);

	const by_fp = new Map<string, DtEvent[]>();
	const global: DtEvent[] = [];
	for (const e of events) {
		if (typeof e.fp === 'string') {
			const arr = by_fp.get(e.fp) ?? [];
			arr.push(e);
			by_fp.set(e.fp, arr);
		} else {
			global.push(e);
		}
	}

	const warnings: string[] = [];
	const blocks: string[] = [];
	for (const [fp, evsRaw] of by_fp) {
		const evs = evsRaw.slice().sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
		const ssr = has(evs, 'server.region.rendered');
		const connected = has(evs, 'region.connected');
		const woke = has(evs, 'wake.fired');
		const done = has(evs, 'region.hydrate.done');
		const failed = has(evs, 'region.hydrate.failed');
		const applied = has(evs, 'region.server.applied');
		const props = has(evs, 'wire.props');
		const scheduled = has(evs, 'wake.scheduled');
		const replay = has(evs, 'interaction.replay');
		const strategy = String(connected?.wake ?? scheduled?.when ?? '(unknown)');
		const entry = connected?.entry ?? scheduled?.entry ?? evs.find((e) => e.entry)?.entry;
		const label = entry ? base(String(entry)) : `#${short(fp)}`;

		let status = '✅';
		if (failed) status = '❌';
		else if (ssr && !connected) status = '⚠️';
		else if (connected && !done && !applied) status = '⏳';

		const lines: string[] = [];
		if (ssr) lines.push(`  · SSR'd on the server${when(ssr)}`);
		if (props) lines.push(`  · props crossed the wire${props.bytes != null ? ` (${props.bytes} B)` : ''}`);
		if (connected) lines.push(`  · region connected — wake: ${strategy}${connected.nested ? ', nested (rides an awake ancestor)' : ''}${connected.deferred ? ', deferred hole' : ''}${when(connected)}`);
		if (woke) lines.push(`  · wake fired${when(woke)}`);
		if (applied) lines.push(`  · deferred HTML applied${applied.bytes != null ? ` (${applied.bytes} B)` : ''}${when(applied)}`);
		if (done) lines.push(`  · hydrated${done.ms != null ? ` in ${Math.round(Number(done.ms) * 10) / 10}ms` : ''} — interactive${when(done)}`);
		if (replay) lines.push(`  · replayed ${replay.clicks ?? '?'} queued click(s) after wake`);
		if (failed) lines.push(`  · HYDRATION FAILED${failed.error ? `: ${failed.error}` : ''}`);

		blocks.push(`### ${status}  ${label}${strategy !== '(unknown)' ? ` — wake:${strategy}` : ''}${entry ? `  (#${short(fp)})` : ''}\n${lines.join('\n')}`);

		if (failed) warnings.push(`#${short(fp)}: hydration failed${failed.error ? ` — ${failed.error}` : ''}.`);
		else if (ssr && !connected)
			warnings.push(`#${short(fp)}: SSR'd but the region never connected — its custom element never ran (island JS not shipped/loaded, or a csr=true/false mismatch).`);
		else if (connected && strategy === 'load' && !done)
			warnings.push(`#${short(fp)}: connected with wake:load but never finished hydrating — stuck or errored mid-wake.`);
	}

	const boot = global.find((e) => e.name === 'runtime.boot');
	const navs = global.filter((e) => e.name.startsWith('nav.'));
	const header =
		`# Runtime story — ${url}\n\n` +
		`${by_fp.size} island(s) · ${events.length} events` +
		(boot ? ` · runtime booted (${(boot.installers as string[] | undefined)?.join(', ') || 'installers ran'})` : '') +
		(navs.length ? ` · ${navs.filter((n) => n.name === 'nav.finish').length} navigation(s)` : '');

	return (
		`${header}\n\n${blocks.join('\n\n')}` +
		(warnings.length ? `\n\n## ⚠️ Warnings (${warnings.length})\n${warnings.map((w) => `- ${w}`).join('\n')}` : '\n\n## ✅ No lifecycle anomalies detected.')
	);
}

/** Load a REAL page in a headless browser, let its islands hydrate, and read the devtools stream. */
async function tool_debug(args: Attrs): Promise<ToolResult> {
	const url = String(args.url ?? '');
	if (!url) return fail('`url` is required — a page of a running ogygia app built with OGYGIA_DEVTOOLS=1.');
	const wait = typeof args.wait === 'number' ? Math.min(Math.max(args.wait, 200), 8000) : 2500;
	const do_scroll = args.scroll !== false;
	const click_sel = typeof args.click === 'string' ? args.click : '';

	let chromium: (typeof import('playwright'))['chromium'];
	try {
		// A VARIABLE specifier so the bundler can't freeze it to a concrete node_modules path — Playwright
		// is an optional peer (only ogygia_debug needs it), resolved from the consumer's install at runtime.
		const spec = 'playwright';
		({ chromium } = (await import(spec)) as typeof import('playwright'));
	} catch {
		return fail('ogygia_debug needs Playwright: `npm i -D playwright && npx playwright install chromium`.');
	}
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	try {
		browser = await chromium.launch();
	} catch (e) {
		return fail(`could not launch a browser (${e instanceof Error ? e.message : String(e)}). Try \`npx playwright install chromium\`.`);
	}
	try {
		const page = await browser.newPage();
		try {
			await page.goto(url, { waitUntil: 'load', timeout: 15000 });
		} catch (e) {
			return fail(`could not load ${url} — is the dev server up? (${e instanceof Error ? e.message : String(e)})`);
		}
		const has_hook = await page.evaluate(() => typeof (window as { __ogygia_devtools?: unknown }).__ogygia_devtools !== 'undefined');
		if (!has_hook)
			return fail(
				`${url} loaded, but window.__ogygia_devtools is absent — the app is not a devtools build. Run its dev/build with ` +
					`OGYGIA_DEVTOOLS=1 (or ogygia({ devtools: true }) in vite.config), then retry.`
			);
		await page.waitForTimeout(wait);
		if (do_scroll) {
			// Trigger `visible` islands the way a user would.
			await page.evaluate(async () => {
				for (let y = 0; y <= document.body.scrollHeight; y += 400) {
					window.scrollTo(0, y);
					await new Promise((r) => setTimeout(r, 120));
				}
				window.scrollTo(0, 0);
			});
			await page.waitForTimeout(500);
		}
		if (click_sel) {
			await page.click(click_sel, { timeout: 3000 }).catch(() => {});
			await page.waitForTimeout(400);
		}
		const trace = (await page.evaluate(() => (window as { __ogygia_devtools: { trace(): { events: unknown[] } } }).__ogygia_devtools.trace())) as {
			events: DtEvent[];
		};
		return text(render_story(url, trace.events ?? []));
	} finally {
		await browser.close();
	}
}

// ── ogygia_profile — run the SSR profiler on a route + digest its agent JSON ────────────────────────

const sev_icon: Record<string, string> = { critical: '❌', error: '❌', warn: '⚠️', warning: '⚠️', info: 'ℹ️', good: '✅' };
const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type ProfileReport = {
	target?: { page?: string; request?: string; runs?: number[] };
	dev?: boolean;
	summary?: { verdict?: string; window_ms?: number; busy_ms?: number; busy_pct?: number; cpu_percent?: number; rss_mb?: number };
	findings?: Array<{ severity?: string; code?: string; message?: string }>;
	budget?: Array<{ label?: string; category?: string; ms?: number; pct?: number }>;
	hot_functions?: Array<{ name?: string; file?: string; line?: number; category?: string; self_ms?: number; per_call_ms?: number }>;
	components?: Array<{ name?: string; instances?: number; self_ms?: number; total_ms?: number; alloc_bytes?: number | null }>;
	network?: { count?: number; total_ms?: number; sequential_ms?: number; errors?: number };
	memory?: { rss_start_mb?: number; rss_end_mb?: number; growth_mb?: number; allocators?: Array<{ name?: string; category?: string; self_bytes?: number }> };
	links?: { html?: string; json?: string; cpuprofile?: string };
};

function render_profile(origin: string, r: ProfileReport): string {
	const target = r.target?.page ?? r.target?.request ?? '(unknown)';
	const runs = r.target?.runs ?? [];
	const s = r.summary ?? {};
	const head =
		`# SSR profile — ${target}${runs.length ? ` · ${runs.length} run(s)` : ''}\n\n` +
		`**${s.verdict ?? 'profiled'}** · render p50 ~${median(runs).toFixed(2)}ms` +
		(runs.length ? ` (runs: ${runs.join(', ')})` : '') +
		(s.busy_ms != null ? ` · CPU busy ${s.busy_ms}ms/${s.window_ms}ms (${s.busy_pct}%)` : '') +
		(s.rss_mb != null ? ` · RSS ${s.rss_mb} MB` : '');

	// In dev, profiler instrumentation dominates the window — say so, so the numbers aren't over-read.
	const prof_overhead = (r.budget ?? []).find((b) => b.category === 'profiler');
	const dev_note = r.dev
		? `\n\n> ⚠️ DEV build${prof_overhead ? ` — ${prof_overhead.pct}% of the window is profiler/instrument overhead` : ''}. Timings are indicative; profile a PROD build (\`vite build && vite preview\`) for real cost.`
		: '';

	const findings = (r.findings ?? [])
		.map((f) => `- ${sev_icon[f.severity ?? 'info'] ?? '•'} ${f.message ?? f.code ?? ''}`)
		.join('\n');

	// Where the time went. Always drop the profiler's own overhead. In DEV also drop Vite and its bundler
	// paths (transform, module load, rolldown) — they dominate the window and aren't in the prod path — and
	// recompute each share over the REMAINING (app) time, so the app's real proportion is legible.
	const dev_noise = new Set(['vite', '.vite', 'rolldown', 'esbuild']);
	const is_noise = (b: { label?: string; category?: string }) =>
		b.category === 'profiler' || (r.dev === true && dev_noise.has((b.label ?? '').toLowerCase()));
	const kept = (r.budget ?? []).filter((b) => !is_noise(b));
	const kept_total = kept.reduce((sum, b) => sum + (b.ms ?? 0), 0) || 1;
	const budget = kept
		.slice(0, 8)
		.map((b) => `- ${b.label}: ${b.ms}ms (${(((b.ms ?? 0) / kept_total) * 100).toFixed(1)}%)`)
		.join('\n');
	const budget_title = r.dev
		? 'Where the time went (Vite + profiler overhead excluded; % of remaining app time)'
		: 'Where the time went (profiler overhead excluded)';

	// Hottest functions that aren't profiler noise, by self time.
	const hot = (r.hot_functions ?? [])
		.filter((h) => h.category !== 'profiler')
		.sort((a, b) => (b.self_ms ?? 0) - (a.self_ms ?? 0))
		.slice(0, 8)
		.map((h, i) => `${i + 1}. ${h.name} — ${h.self_ms}ms self${h.category ? ` [${h.category}]` : ''}${h.file ? ` · ${base(h.file)}${h.line ? `:${h.line}` : ''}` : ''}`)
		.join('\n');

	const comps = (r.components ?? [])
		.sort((a, b) => (b.self_ms ?? 0) - (a.self_ms ?? 0))
		.slice(0, 10)
		.map((c) => `- ${c.name} ×${c.instances ?? 1} — ${c.self_ms}ms self${c.alloc_bytes ? `, ${Math.round(c.alloc_bytes / 1024)} KB alloc` : ''}`)
		.join('\n');

	const net = r.network;
	const net_line = net ? `${net.count ?? 0} call(s)${net.total_ms ? `, ${net.total_ms}ms total` : ''}${net.errors ? `, ${net.errors} error(s)` : ''}` : 'n/a';
	const mem = r.memory;
	const mem_line = mem ? `RSS ${mem.rss_start_mb}→${mem.rss_end_mb} MB (+${mem.growth_mb})` : 'n/a';

	const links = r.links
		? `\n\nFull report: ${origin}${r.links.html}${r.links.json ? ` · JSON: ${origin}${r.links.json}` : ''}${r.links.cpuprofile ? ` · .cpuprofile: ${origin}${r.links.cpuprofile}` : ''}`
		: '';

	return (
		head +
		dev_note +
		(findings ? `\n\n## Findings\n${findings}` : '') +
		(budget ? `\n\n## ${budget_title}\n${budget}` : '') +
		(hot ? `\n\n## Hottest functions (self ms)\n${hot}` : '') +
		(comps ? `\n\n## Components\n${comps}` : '') +
		`\n\n## Network: ${net_line}  ·  Memory: ${mem_line}` +
		links
	);
}

/** Record an SSR profile of a route on the running app + return the digested findings. */
async function tool_profile(args: Attrs): Promise<ToolResult> {
	const raw = String(args.url ?? '');
	if (!raw) return fail('`url` is required — the route to profile, e.g. http://localhost:5173/blog.');
	let origin: string;
	let route: string;
	try {
		const u = new URL(raw);
		origin = u.origin;
		route = u.pathname + u.search;
	} catch {
		return fail(`invalid url: ${raw}`);
	}
	const profiler_base = String(args.base ?? '/__profiler').replace(/\/$/, '');
	const runs = typeof args.runs === 'number' ? Math.min(Math.max(Math.round(args.runs), 1), 50) : 5;
	const key = typeof args.key === 'string' ? args.key : '';
	const key_q = key ? `?key=${encodeURIComponent(key)}` : '';

	// Precheck: is the profiler mounted? (a clean "add it to hooks" message beats a cryptic failure)
	let pre: Response;
	try {
		pre = await fetch(origin + profiler_base + key_q, { redirect: 'manual' });
	} catch (e) {
		return fail(`could not reach ${origin} — is the dev/preview server running? (${e instanceof Error ? e.message : String(e)})`);
	}
	if (pre.status === 404) {
		return fail(
			`The profiler is not mounted at ${profiler_base} on ${origin}. Add it to src/hooks.server.ts:\n\n` +
				`  import { sequence } from '@sveltejs/kit/hooks';\n` +
				`  import { profiler } from 'ogygia/profiler';\n` +
				`  export const handle = sequence(profiler(), /* …your other handles */);\n\n` +
				`Put profiler() FIRST so it times the whole chain. Restart the server, then retry.`
		);
	}

	const rec = new URL(origin + profiler_base + '/page');
	rec.searchParams.set('p', route);
	rec.searchParams.set('format', 'json');
	rec.searchParams.set('runs', String(runs));
	if (key) rec.searchParams.set('key', key);
	let res: Response;
	try {
		res = await fetch(rec, { headers: { accept: 'application/json' } });
	} catch (e) {
		return fail(`recording failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if ((res.headers.get('content-type') ?? '').includes('application/json')) {
		return text(render_profile(origin, (await res.json()) as ProfileReport));
	}
	const body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
	if (res.status === 409) return fail(`A profile is already running on ${origin}. Wait a moment and retry.`);
	return fail(`profiler did not return JSON (HTTP ${res.status}). ${body || '(check the profiler key / route path)'}`);
}

async function tool_profile_open(args: Attrs): Promise<ToolResult> {
	const file = String(args.file ?? '');
	if (!file) return fail('`file` is required — the path to a downloaded .ogp profile.');
	const key = typeof args.key === 'string' && args.key ? args.key : undefined;

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path.resolve(file)));
	} catch (e) {
		return fail(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!is_ogp(bytes)) return fail(`${file} is not an ogygia .ogp profile (bad magic).`);

	// The encryption IS the authorization: decrypt straight from the file, no server, no profiler login.
	let dump: unknown;
	try {
		dump = await ogp_decode(bytes, key);
	} catch {
		return fail(
			key
				? `Could not open ${file} — that export key does not match this .ogp (its AES tag failed). Confirm the key it was exported with.`
				: `${file} is encrypted. Re-run with \`key\` set to the export key it was made with. Ask the user for it if you don’t have it — it is the .ogp’s own key, not the app’s profiler secret.`
		);
	}
	if (!is_dump(dump)) return fail(`${file} decrypted, but it is not an ogygia profiler dump.`);

	const report = report_json(dump.analysis, dump.meta, '/__profiler', dump.extras) as ProfileReport;
	report.links = undefined; // the source server is gone — its report URLs would 404
	const node = (dump.meta as { node?: string }).node;
	return text(`> Imported from \`${file}\`${node ? ` · Node ${node}` : ''}\n\n` + render_profile('', report));
}

// ── ogygia_observatory — bundle files into a client-only Observatory link ──────────────────────────

const DEFAULT_OBSERVATORY = 'https://ogygia.puruvj.dev/observatory';

/** `#<base64url(gzip(json))>` — the EXACT single-string format the Observatory decodes (browser gunzip).
 *  The payload is `{ f: files }` (files only; the app fills in default UI state). */
function observatory_link(files: Record<string, string>, base: string): string {
	const gz = gzipSync(Buffer.from(JSON.stringify({ f: files }), 'utf8'));
	const b64url = gz.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return `${base.replace(/#.*$/, '')}#${b64url}`;
}

function tool_observatory(args: Attrs): ToolResult {
	let files: Record<string, string> = {};
	if (args.files && typeof args.files === 'object' && !Array.isArray(args.files)) {
		for (const [k, v] of Object.entries(args.files as Record<string, unknown>)) if (typeof v === 'string') files[k] = v;
	} else if (typeof args.source === 'string') {
		files[String(args.filename ?? 'App.svelte')] = args.source;
	}
	const names = Object.keys(files);
	if (!names.length) return fail('Provide `files` (a map of filename → source) or `source` (+ optional `filename`).');
	if (!names.some((n) => n.endsWith('.svelte')))
		return text(`⚠️ No .svelte file given — the Observatory renders a Svelte component (App.svelte is the entry). Add one.\n\nFiles: ${names.join(', ')}`);

	const base = String(args.base ?? DEFAULT_OBSERVATORY);
	const url = observatory_link(files, base);
	const long = url.length > 8000 ? `\n\n⚠️ The link is ${url.length} chars — some tools truncate very long URLs. Trim to the files that matter if it breaks.` : '';
	return text(
		`Open this in the ogygia Observatory to see ${names.length === 1 ? 'this component' : `these ${names.length} files`} compiled live — the island map, byte ledger, wire payloads, and a real hydrating preview:\n\n` +
			`${url}\n\n` +
			`🔒 Client-only: the code is packed into the URL's **# fragment**, which browsers NEVER send to a server — nothing here touches ogygia's (or anyone's) servers. It compiles entirely in your browser.${long}`
	);
}

// ── ogygia_scan — walk a real project, map every island + lint the whole codebase ──────────────────

const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '.git', 'dist', 'build', '.vercel', '.netlify', 'coverage']);

function walk_svelte(dir: string, out: string[] = [], depth = 0): string[] {
	if (depth > 12 || out.length > 2000) return out;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith('.') && e.name !== '.') continue;
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) walk_svelte(path.join(dir, e.name), out, depth + 1);
		} else if (e.name.endsWith('.svelte')) {
			out.push(path.join(dir, e.name));
		}
	}
	return out;
}

type ScanIsland = { component: string; local: string; kind: string; strategy: string; attrs: Attrs; file: string };
type Violation = { file: string; severity: 'error' | 'warn'; msg: string };

function tool_scan(args: Attrs): ToolResult {
	const dir = String(args.dir ?? 'src');
	const root = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
	const files = walk_svelte(root);
	if (!files.length) return fail(`No .svelte files found under ${dir} (cwd: ${process.cwd()}). Pass \`dir\` (e.g. "src" or "src/routes").`);

	const rel = (f: string) => path.relative(root, f) || path.basename(f);
	const islands: ScanIsland[] = [];
	const violations: Violation[] = [];
	const kinds: Record<string, number> = {};
	let preset_marks = 0;
	// component basename → the marks that make it an island (for island-in-island detection)
	const island_components = new Set<string>();

	const per_file: Array<{ marks: Mark[]; file: string }> = [];
	for (const f of files.slice(0, 1500)) {
		let source: string;
		try {
			source = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		const marks = parse_marks(source);
		if (!marks.length) continue;
		per_file.push({ marks, file: f });

		// Real kinds + hard errors from the transform. The id is the clean relative path (nice messages).
		const kind_by_component = new Map<string, string>();
		try {
			const r = transformHost(source, '/' + rel(f).replace(/\\/g, '/'), build_ctx(true)) as HostResult;
			for (const isl of r?.islands ?? []) if (isl.componentPath) kind_by_component.set(base(isl.componentPath), isl.kind ?? '');
		} catch (e) {
			const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
			// "unknown preset" is a scan limitation (we don't load the app's ogygia({ regions: { presets } })
			// config), not a real violation — count it for a footnote instead of flagging it.
			if (/unknown preset/i.test(raw)) preset_marks++;
			else violations.push({ file: rel(f), severity: 'error', msg: raw });
		}

		for (const m of marks) {
			const kind = kind_by_component.get(base(m.component)) ?? '(mark only)';
			islands.push({ component: m.component, local: m.local, kind, strategy: strategy_label(m.attrs), attrs: m.attrs, file: rel(f) });
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			// a real interactive island (not a lake/raw) — remember its component basename
			if (m.attrs.wake !== 'none' && m.attrs.region !== 'raw') island_components.add(base(m.component));

			// ── soft lints (per mark) ──
			if (m.attrs.wake === 'none' && m.attrs.render === 'deferred')
				violations.push({ file: rel(f), severity: 'warn', msg: `${m.component}: wake:'none' + render:'deferred' is nonsense (HTML later, no JS) — dev treats it as defer-only. Drop one.` });
			if (m.attrs.wake === 'interaction' && m.attrs.render === 'deferred')
				violations.push({ file: rel(f), severity: 'warn', msg: `${m.component}: render:'deferred' ignores wake:'interaction' (a server island renders inline in an island). Nest a wake island inside it instead.` });
		}
	}

	// ── cross-file lint: island-in-island — a file that IS used as an island AND marks its own islands.
	for (const { marks, file } of per_file) {
		const this_base = base(file).replace(/\.svelte$/, '');
		if (!island_components.has(base(file))) continue; // this component isn't used as an island anywhere
		for (const m of marks) {
			if (m.attrs.wake === 'none' || m.attrs.region === 'raw') continue;
			violations.push({
				file: rel(file),
				severity: 'warn',
				msg: `${m.component} is marked inside ${this_base} — but ${this_base} is itself an island elsewhere, so this is island-in-island: the child shares the parent's JS and its own wake is ignored (dev warns). Only the closest marked parent's schedule wins.`
			});
		}
	}

	if (!islands.length) return text(`Scanned ${files.length} .svelte file(s) under ${dir} — no marked regions. The whole tree is free server HTML.`);

	const by_file = new Map<string, ScanIsland[]>();
	for (const i of islands) (by_file.get(i.file) ?? by_file.set(i.file, []).get(i.file)!).push(i);
	const map_lines = [...by_file.entries()]
		.map(([file, list]) => `### ${file}\n${list.map((i) => `- ${i.component} (as ${i.local}) — ${i.strategy}`).join('\n')}`)
		.join('\n\n');
	const kind_summary = Object.entries(kinds)
		.map(([k, n]) => `${n} ${k}`)
		.join(' · ');
	const errs = violations.filter((v) => v.severity === 'error');
	const warns = violations.filter((v) => v.severity === 'warn');
	const vio_block = violations.length
		? `\n\n## ⚠️ Findings (${violations.length})\n` +
			[...errs, ...warns].map((v) => `- ${v.severity === 'error' ? '❌' : '⚠️'} ${v.file}: ${v.msg}`).join('\n')
		: `\n\n## ✅ No rule violations across ${files.length} files.`;

	const preset_note = preset_marks
		? `\n\n> ${preset_marks} import(s) use a \`preset\` — resolved from your \`ogygia({ regions: { presets } })\` config at build, not checked here.`
		: '';
	return text(
		`# ogygia scan — ${dir}\n\n` +
			`${islands.length} marked region(s) across ${by_file.size} file(s) (${files.length} .svelte scanned) · ${kind_summary}\n\n` +
			`## Island map\n${map_lines}` +
			vio_block +
			preset_note
	);
}

async function dispatch_tool(name: string, args: Attrs): Promise<ToolResult> {
	switch (name) {
		case 'ogygia_compile':
			return tool_compile(args);
		case 'ogygia_islands':
			return tool_islands(args);
		case 'ogygia_check':
			return tool_check(args);
		case 'ogygia_explain':
			return tool_explain(args);
		case 'ogygia_debug':
			return tool_debug(args);
		case 'ogygia_profile':
			return tool_profile(args);
		case 'ogygia_profile_open':
			return tool_profile_open(args);
		case 'ogygia_observatory':
			return tool_observatory(args);
		case 'ogygia_scan':
			return tool_scan(args);
		default:
			return fail(`Unknown tool: ${name}`);
	}
}

// ── JSON-RPC 2.0 over stdio ────────────────────────────────────────────────────

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

function send(msg: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(msg) + '\n');
}
function log(...parts: unknown[]): void {
	process.stderr.write('[ogygia mcp] ' + parts.map(String).join(' ') + '\n');
}

function handle(msg: Rpc): void {
	const { id, method, params } = msg;
	if (method === 'initialize') {
		send({
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version }
			}
		});
		return;
	}
	if (method === 'tools/list') {
		send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
		return;
	}
	if (method === 'tools/call') {
		const name = String(params?.name ?? '');
		const args = (params?.arguments as Attrs) ?? {};
		dispatch_tool(name, args)
			.then((result) => send({ jsonrpc: '2.0', id, result }))
			.catch((e) => send({ jsonrpc: '2.0', id, result: fail(`Internal error: ${e instanceof Error ? e.message : String(e)}`) }));
		return;
	}
	if (method === 'ping') {
		send({ jsonrpc: '2.0', id, result: {} });
		return;
	}
	// Notifications (no id) — nothing to answer.
	if (method?.startsWith('notifications/') || id == null) return;
	send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

/** Start the stdio MCP server. Resolves when stdin closes (the client disconnected). */
export async function runMcp(): Promise<void> {
	log(`ogygia MCP server v${version} ready — 8 tools (compile, islands, check, explain, debug, profile, observatory, scan)`);
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let msg: Rpc;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			log('dropped non-JSON line');
			continue;
		}
		try {
			handle(msg);
		} catch (e) {
			log('handler threw:', e instanceof Error ? e.message : String(e));
		}
	}
}
