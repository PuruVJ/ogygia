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
import path from 'node:path';
import { parse } from 'svelte/compiler';
import { transformHost, islandVirtualId, wrapperVirtualId, CLIENT_BINDING_STUB } from './compiler/index.js';

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
	log(`ogygia MCP server v${version} ready — 5 tools (compile, islands, check, explain, debug)`);
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
