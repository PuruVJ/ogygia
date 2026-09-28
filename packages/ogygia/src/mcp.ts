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
import {
	transformHost,
	islandVirtualId,
	wrapperVirtualId,
	CLIENT_BINDING_STUB
} from './compiler/index.js';
import { collect_flag_sites, flags_manifest, type FlagSite } from './compiler/flags.js';
import { ogp_decode, is_ogp } from './profiler/crypto.js';
import { report_json, is_dump } from './profiler/report.js';
import { fix_impact } from './profiler/patterns.js';

// ── regexes
const TRAILING_SLASH_RE = /\/$/;
const HTTP_URL_RE = /^https?:\/\//i;
const LOGIN_FORM_RE = /id="og-login"/;
const HTML_TAG_G = /<[^>]+>/g;
const WS_G = /\s+/g;
const PLUS_G = /\+/g;
const SLASH_G = /\//g;
const TRAILING_EQUALS_RE = /=+$/;
const HASH_SUFFIX_RE = /#.*$/;
const BACKSLASH_G = /\\/g;
const UNKNOWN_PRESET_RE = /unknown preset/i;
const SVELTE_EXT_RE = /\.svelte$/;

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
			const key =
				(a.key as { name?: string; value?: string })?.name ?? (a.key as { value?: string })?.value;
			if (key) attrs[key] = (a.value as { value?: unknown })?.value;
		}
		if (!Object.keys(attrs).some((k) => MARK_KEYS.has(k))) continue;
		const local =
			(node.specifiers as Array<{ local?: { name?: string } }>)?.[0]?.local?.name ?? '?';
		const component = (node.source as { value: string }).value;
		marks.push({ local, component, attrs });
	}
	return marks;
}

const base = (p?: string) => (p ? p.split('?')[0].split('/').pop() || p : '');

/** A one-line, human/AI-legible label for what a mark's dials make it. */
function strategy_label(attrs: Attrs): string {
	if (attrs.region === 'raw') return 'held region (raw — HTML only, ships no JS)';
	if (attrs.render === 'deferred')
		return `server island (deferred, fetched on ${attrs.wake ?? 'load'})`;
	if (attrs.render === 'live') return 'live region (baked, revalidates in background)';
	if (attrs.wake === 'none') return 'lake (frozen server HTML, ships no JS)';
	if (attrs.render === 'deferred' && attrs.wake === 'interaction')
		return 'on-demand server island (HTML fetched on the first hover/focus/touch inside, morphed in; ships no JS)';
	const wake = (attrs.wake as string) ?? 'load';
	return `island (interactive, wakes on ${wake})${attrs.keep ? `, kept across nav as "${attrs.keep}"` : ''}`;
}

type Island = {
	component: string;
	local: string;
	kind: string;
	strategy: string;
	attrs: Attrs;
	id: string;
};

/** Run the real transform + merge in the marks → the island map an AI can read. Throws are the caller's. */
function compile(
	source: string,
	filename: string,
	ssr: boolean,
	route_csr: boolean
): { code: string; islands: Island[] } {
	const id = `/repl/src/routes/${filename}`;
	const result = transformHost(source, id, build_ctx(ssr, route_csr)) as HostResult;
	const marks = parse_marks(source);
	const list = result?.islands ?? [];
	// Real md5 id + authoritative kind come from transformHost; local + dials come from the marks.
	const real_by_component = new Map<string, HostIsland>();
	for (const isl of list)
		if (isl.componentPath) real_by_component.set(base(isl.componentPath), isl);
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
					description:
						'true = compile the csr=true leg (ogygia steps aside, islands stripped to plain). Default false.'
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
			properties: {
				source: { type: 'string', description: 'The .svelte component source to validate.' }
			},
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
				url: {
					type: 'string',
					description: 'URL of a page on the running app (e.g. http://localhost:5173/blog).'
				},
				wait: {
					type: 'number',
					description: 'ms to wait for hydration to settle (default 2500, max 8000).'
				},
				scroll: {
					type: 'boolean',
					description: 'Scroll the page to trigger `visible` islands (default true).'
				},
				click: {
					type: 'string',
					description: 'Optional CSS selector to click, to wake an `interaction` island.'
				}
			},
			required: ['url']
		}
	},
	{
		name: 'ogygia_profile',
		description:
			'Profile the SERVER-SIDE render of a route — runs the whole thing itself, nothing to download. ' +
			'ASK THE USER which URL to profile before calling (they prefer to name the host): a full URL like ' +
			'`http://localhost:5173/fr/fr` (local) or `https://app.com/fr/fr` (remote). Pass it as `url`. ' +
			'A bare path is accepted too, but then the tool just asks you for the URL (and lists any local ' +
			'server it can see). Records N renders and returns a digest: verdict (compute- vs io-bound), render ' +
			'p50, CPU findings, time-by-category, hottest functions + components (Svelte names each after its ' +
			'file), network, heap. Self-heals a stuck session (auto /reset + retry). Requires the app to mount ' +
			'profiler() in hooks.server.ts (the tool tells you how if missing). Prod build = real numbers; dev ' +
			'is indicative (the digest says which). For a report you already downloaded, use ogygia_profile_open.',
		inputSchema: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					description:
						'Route to profile: a bare path (`/fr/fr`) = your local running server (auto-found), or a full URL (`https://app.com/fr/fr`) = that host.'
				},
				runs: {
					type: 'number',
					description: 'Profiled renders to record (default 5, max 50). More = steadier median.'
				},
				key: {
					type: 'string',
					description:
						'Profiler secret (sent as the x-profiler-key header) — needed only when the app set one (prod/locked).'
				},
				origin: {
					type: 'string',
					description:
						'Force a specific local origin (e.g. http://localhost:5173) when a bare path could match several running servers.'
				},
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
				file: {
					type: 'string',
					description: 'Path to the .ogp file (absolute, or relative to the MCP server cwd).'
				},
				key: {
					type: 'string',
					description:
						'The export key the .ogp was made with. Omit only for a dev-key export; a wrong/absent key fails cleanly and asks for it.'
				}
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
				dir: {
					type: 'string',
					description:
						'Directory to scan, relative to the server cwd or absolute (default "src"; try "src/routes").'
				}
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
				files: {
					type: 'object',
					description:
						'Map of filename → source. App.svelte is the entry; include the components it imports.',
					additionalProperties: { type: 'string' }
				},
				source: {
					type: 'string',
					description: 'Single-file convenience: the component source (paired with `filename`).'
				},
				filename: { type: 'string', description: 'Name for `source` (default App.svelte).' },
				base: {
					type: 'string',
					description:
						'Observatory base URL (default the public docs Observatory; use a localhost URL to target a dev build).'
				}
			}
		}
	},
	{
		name: 'ogygia_flags',
		description:
			'Inventory every flag() call site in a project — the same AST collector the build ' +
			'uses (real import bindings from ogygia, renames + namespaces included, literal names only). ' +
			'Live-scans src/, and diffs against the last build manifest (node_modules/.ogygia/flags-manifest.json) ' +
			'when present. Use it to audit rollouts, find dead flags, or list what ?og-exp can override.',
		inputSchema: {
			type: 'object',
			properties: {
				dir: {
					type: 'string',
					description:
						'Project root (the directory containing src/ and node_modules/), relative to the server cwd or absolute. Default ".".'
				}
			}
		}
	},
	{
		name: 'ogygia_fragment',
		description:
			'Probe a federated ogygia app origin. Reports whether its fragment endpoint verifies signatures ' +
			'(an unsigned request should get 401 — a 200 means the endpoint is OPEN) and fetches the unsigned ' +
			'__catalog widget manifest (names + props, plus the typed-stub command). Use it BEFORE writing ' +
			'mount(peer) / peer.page() / peer.widget() code against a peer, or to sanity-check an exposed app in review.',
		inputSchema: {
			type: 'object',
			properties: {
				origin: {
					type: 'string',
					description: 'The MFE origin, e.g. https://cms.internal or http://localhost:5174.'
				}
			},
			required: ['origin']
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
		? out.islands
				.map(
					(i) =>
						`- ${i.component} (as ${i.local}) — ${i.strategy}${i.id ? ` · id ${i.id.slice(0, 8)}` : ''}`
				)
				.join('\n')
		: '(no marked components — the whole file is free server HTML)';
	const structured = JSON.stringify(
		{
			csr,
			islands: out.islands.map((i) => ({
				component: i.component,
				kind: i.kind,
				...i.attrs,
				id: i.id
			}))
		},
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
	const structured = out.islands.map((i) => ({
		component: i.component,
		local: i.local,
		kind: i.kind,
		...i.attrs,
		id: i.id
	}));
	return text(
		`${out.islands.length} marked region(s)\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``
	);
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
		return text(
			'This component marks nothing, so it ships as pure server HTML — zero JavaScript, no islands.'
		);
	const lines = out.islands.map((i) => {
		const a = i.attrs;
		if (a.region === 'raw')
			return `• ${i.component}: a held region marked \`raw\` — server picks it, it renders as HTML and ships no JS.`;
		if (a.render === 'deferred')
			return `• ${i.component}: a server island. Its HTML is fetched later from a signed endpoint (on ${a.wake ?? 'load'}); show \`ogygiaFallback\` while it loads. Not interactive unless it nests its own wake island.`;
		if (a.render === 'live')
			return `• ${i.component}: a live region — baked at request, then revalidated in the background and morphed in place.`;
		if (a.wake === 'none')
			return `• ${i.component}: a lake — heavy static subtree frozen to server HTML inside an island; ships no JS of its own.`;
		const wake = a.wake ?? 'load';
		const keep = a.keep
			? ` It is kept across SPA navigation as "${a.keep}" — its live \`$state\` survives the nav.`
			: '';
		return `• ${i.component}: an island. Its own hydration root; JS wakes on ${wake}. Props cross by value (devalue) — functions never cross, captured host state is a snapshot.${keep}`;
	});
	return text(`How this page behaves at runtime:\n\n${lines.join('\n')}`);
}

// ── ogygia_debug — the RUNTIME half: drive a headless browser over a real page ─────────────────────

/** One event off `window.__ogygia_devtools` — the fp-correlated devtools stream (schema in devtools/). */
type DtEvent = {
	name: string;
	fp?: string;
	entry?: string;
	realm?: string;
	seq?: number;
	t?: number;
	[k: string]: unknown;
};

const short = (fp: string) => fp.slice(0, 8);

/** Turn the raw event stream into a per-island runtime story + invariant warnings an AI can act on. */
function render_story(url: string, events: DtEvent[]): string {
	if (!events.length)
		return `Loaded ${url}, but the devtools bus emitted no events — no islands on this page, or nothing had happened yet.`;

	// Server (SSR) events are stamped with the SERVER process's `performance.now()` — a different clock
	// than the browser's — so relative timing is computed from CLIENT events only; server events just
	// read "SSR'd" with no client-relative ms.
	const client_ts = events.filter((e) => e.realm === 'client').map((e) => Number(e.t ?? 0));
	const t0 = client_ts.length
		? Math.min(...client_ts)
		: Math.min(...events.map((e) => Number(e.t ?? 0)));
	const at = (e: DtEvent) =>
		e.realm === 'server' ? '' : `+${Math.round(Number(e.t ?? t0) - t0)}ms`;
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
		if (props)
			lines.push(`  · props crossed the wire${props.bytes != null ? ` (${props.bytes} B)` : ''}`);
		if (connected)
			lines.push(
				`  · region connected — wake: ${strategy}${connected.nested ? ', nested (rides an awake ancestor)' : ''}${connected.deferred ? ', deferred hole' : ''}${when(connected)}`
			);
		if (woke) lines.push(`  · wake fired${when(woke)}`);
		if (applied)
			lines.push(
				`  · deferred HTML applied${applied.bytes != null ? ` (${applied.bytes} B)` : ''}${when(applied)}`
			);
		if (done)
			lines.push(
				`  · hydrated${done.ms != null ? ` in ${Math.round(Number(done.ms) * 10) / 10}ms` : ''} — interactive${when(done)}`
			);
		if (replay) lines.push(`  · replayed ${replay.clicks ?? '?'} queued click(s) after wake`);
		if (failed) lines.push(`  · HYDRATION FAILED${failed.error ? `: ${failed.error}` : ''}`);

		blocks.push(
			`### ${status}  ${label}${strategy !== '(unknown)' ? ` — wake:${strategy}` : ''}${entry ? `  (#${short(fp)})` : ''}\n${lines.join('\n')}`
		);

		if (failed)
			warnings.push(`#${short(fp)}: hydration failed${failed.error ? ` — ${failed.error}` : ''}.`);
		else if (ssr && !connected)
			warnings.push(
				`#${short(fp)}: SSR'd but the region never connected — its custom element never ran (island JS not shipped/loaded, or a csr=true/false mismatch).`
			);
		else if (connected && strategy === 'load' && !done)
			warnings.push(
				`#${short(fp)}: connected with wake:load but never finished hydrating — stuck or errored mid-wake.`
			);
	}

	const boot = global.find((e) => e.name === 'runtime.boot');
	const navs = global.filter((e) => e.name.startsWith('nav.'));
	const header =
		`# Runtime story — ${url}\n\n` +
		`${by_fp.size} island(s) · ${events.length} events` +
		(boot
			? ` · runtime booted (${(boot.installers as string[] | undefined)?.join(', ') || 'installers ran'})`
			: '') +
		(navs.length ? ` · ${navs.filter((n) => n.name === 'nav.finish').length} navigation(s)` : '');

	return (
		`${header}\n\n${blocks.join('\n\n')}` +
		(warnings.length
			? `\n\n## ⚠️ Warnings (${warnings.length})\n${warnings.map((w) => `- ${w}`).join('\n')}`
			: '\n\n## ✅ No lifecycle anomalies detected.')
	);
}

/** Load a REAL page in a headless browser, let its islands hydrate, and read the devtools stream. */
async function tool_debug(args: Attrs): Promise<ToolResult> {
	const url = String(args.url ?? '');
	if (!url)
		return fail('`url` is required — a page of a running ogygia app built with OGYGIA_DEVTOOLS=1.');
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
		return fail(
			'ogygia_debug needs Playwright: `npm i -D playwright && npx playwright install chromium`.'
		);
	}
	let browser: Awaited<ReturnType<typeof chromium.launch>>;
	try {
		browser = await chromium.launch();
	} catch (e) {
		return fail(
			`could not launch a browser (${e instanceof Error ? e.message : String(e)}). Try \`npx playwright install chromium\`.`
		);
	}
	try {
		const page = await browser.newPage();
		try {
			await page.goto(url, { waitUntil: 'load', timeout: 15000 });
		} catch (e) {
			return fail(
				`could not load ${url} — is the dev server up? (${e instanceof Error ? e.message : String(e)})`
			);
		}
		const has_hook = await page.evaluate(
			() => typeof (window as { __ogygia_devtools?: unknown }).__ogygia_devtools !== 'undefined'
		);
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
		const trace = (await page.evaluate(() =>
			(
				window as { __ogygia_devtools: { trace(): { events: unknown[] } } }
			).__ogygia_devtools.trace()
		)) as {
			events: DtEvent[];
		};
		return text(render_story(url, trace.events ?? []));
	} finally {
		await browser.close();
	}
}

// ── ogygia_profile — run the SSR profiler on a route + digest its agent JSON ────────────────────────

const sev_icon: Record<string, string> = {
	critical: '❌',
	error: '❌',
	warn: '⚠️',
	warning: '⚠️',
	info: 'ℹ️',
	good: '✅'
};
const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type ProfileReport = {
	target?: { page?: string; request?: string; runs?: number[] };
	dev?: boolean;
	/** one render's critical path: its waiting caps what the wait fixes together take off */
	timeline?: { wait_ms?: number } | null;
	/** one render after every fix named, overlapping fixes counted once (forecast.ts) */
	forecast?: import('./profiler/forecast.js').Forecast | null;
	summary?: {
		verdict?: string;
		window_ms?: number;
		busy_ms?: number;
		busy_pct?: number;
		cpu_percent?: number;
		rss_mb?: number;
	};
	findings?: Array<{ severity?: string; code?: string; message?: string }>;
	budget?: Array<{ label?: string; category?: string; ms?: number; pct?: number }>;
	hot_functions?: Array<{
		name?: string;
		label?: string | null;
		file?: string;
		line?: number;
		category?: string;
		self_ms?: number;
		per_call_ms?: number;
		stacks?: Array<{ ms?: number; frames?: string[] }>;
	}>;
	components?: Array<{
		name?: string;
		instances?: number;
		self_ms?: number;
		total_ms?: number;
		alloc_bytes?: number | null;
	}>;
	network?: { count?: number; total_ms?: number; sequential_ms?: number; errors?: number };
	memory?: {
		rss_start_mb?: number;
		rss_end_mb?: number;
		growth_mb?: number;
		allocators?: Array<{ name?: string; category?: string; self_bytes?: number }>;
	};
	links?: { html?: string; json?: string; cpuprofile?: string };
	/** known slow shapes on the costliest lines, each with its sites, a fix and a saving */
	patterns?: Array<{
		kind?: string;
		title?: string;
		fix?: string;
		evidence?: string;
		save_ms?: number;
		wait?: boolean;
		kept_bytes?: number;
		seed_bytes?: number;
		example?: { before?: string; after?: string };
		sites?: Array<{
			file?: string;
			line?: number;
			/** a built chunk's line: the source module it came from */
			module?: string;
			code?: string;
			via?: Array<{
				file?: string;
				line?: number;
				module?: string;
				code?: string;
				in_loop?: boolean;
			}>;
			upstream_cache?: {
				max_age?: number;
				no_store?: boolean;
				no_cache?: boolean;
				private?: boolean;
			};
			rewrite?: { file: string; line: number; before: string; after: string };
		}>;
	}> | null;
	/** the app lines that cost the most, every cost joined per line */
	/** one render's time as a tree (drill.ts): phase → owner / call → line */
	drill?: DrillShape | null;
	/** against the previous profile of this page (compare.ts `Since`) */
	/** this page's fixes that other profiled pages share: the same line slows them too */
	shared?: {
		kind: string;
		title: string;
		where: string;
		line: number;
		pages: { page: string; ms: number }[];
		total_ms: number;
	}[];
	since?: {
		prev: string;
		a_ms?: number;
		b_ms?: number;
		same?: boolean;
		moved: Array<{ path: string[]; kind: string; at?: string; d_ms: number; status: string }>;
		order?: { earlier: string; kept_mb: number; requests_between: number };
		fix_check?: { predicted_ms: number; measured_ms: number; verdict: string };
		score?: { a: number; b: number; a_grade: string; b_grade: string; moved: { label: string; a: number; b: number }[] };
	} | null;
	ledger?: Array<{
		file?: string;
		line?: number;
		code?: string;
		cpu_ms?: number;
		lib_ms?: number;
		alloc_bytes?: number;
		gc_ms?: number;
		retained_bytes?: number;
		libs?: Array<{ name?: string; pkg?: string }>;
		merged?: { from: number; callee: string };
	}> | null;
};

const kb_or_mb = (b: number) =>
	b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

/**
 * THE PLAN: one ordered list of changes, each a place to edit and what it is worth per render —
 * the slow patterns (memory and shipped-data ones first, then by ms saved), the work that builds
 * data nothing reads (the drill's rows whose every key is unread: delete it), and a page load that
 * waits on its layout for data it uses later. What an agent does first, second, third.
 */
function render_plan(r: ProfileReport): string {
	const n = Math.max(1, r.target?.runs?.length ?? 1);
	/** `key`: what the forecast calls the same saving (a pattern's title; `unread:<keys>` for work
	 *  whose data nothing reads) */
	type Step = { value: number; text: string; key?: string };
	const steps: Step[] = [];
	const first_sentence = (s = '') => {
		const dot = s.indexOf('. ');
		return dot === -1 ? s : s.slice(0, dot + 1);
	};
	// (a pattern inside work that goes away anyway is moot: deleting beats speeding up)
	// every line under such a row (a wait row has none of its own: its calling lines), paths compared
	// without a leading `src/` (the drill and the patterns spell them differently)
	const gone_at = new Set<string>();
	const place = (p: string) => (p.startsWith('src/') ? p.slice(4) : p);
	const all_lines = (d: DrillShape) => {
		if (d.at) gone_at.add(place(d.at));
		for (const c of d.children ?? []) all_lines(c);
	};
	const note = (d: DrillShape) => {
		if (d.fills?.length && d.fills.every((f) => !f.read)) return all_lines(d);
		for (const c of d.children ?? []) note(c);
	};
	if (r.drill) note(r.drill);
	const gone = (x: { file?: string; line?: number }) => gone_at.has(place(`${x.file}:${x.line}`));
	for (const p of r.patterns ?? []) {
		// moot when every site is in that work: its own line, or every line that called it
		if (p.sites?.length && p.sites.every((x) => gone(x) || (!!x.via?.length && x.via.every(gone))))
			continue;
		const s = p.sites?.[0];
		// the line to open: a looping caller, else the first caller of a helper, else the site
		const at = s?.via?.find((v) => v.in_loop) ?? (p.wait ? s?.via?.[0] : undefined) ?? s;
		// a built chunk's line (no sourcemap): which source module it is, then the chunk line
		const where = at?.file
			? at.module
				? `${at.module} (built ${at.file}:${at.line})`
				: `${at.file}:${at.line}`
			: '';
		const worth = p.kept_bytes
			? `keeps ${kb_or_mb(p.kept_bytes)} alive per render`
			: p.seed_bytes
				? `ships ${kb_or_mb(p.seed_bytes)} per page view`
				: `~${Math.round(((p.save_ms ?? 0) / (p.wait ? 1 : n)) * 10) / 10}ms per render`;
		if (!p.kept_bytes && !p.seed_bytes && (p.save_ms ?? 0) <= 0) continue;
		// a severe leak (8 MB+ a render: it ends in a crash) and a whole shipped seed lead; a small kept
		// amount waits behind the time savings
		const value =
			(p.kept_bytes ?? 0) >= 8 * 1024 * 1024 || p.seed_bytes
				? Infinity
				: p.kept_bytes
					? 0.5
					: (p.save_ms ?? 0) / (p.wait ? 1 : n);
		steps.push({
			value,
			key: p.title ?? p.kind,
			text: `**${p.title ?? p.kind}** — ${where ? `\`${where}\` · ` : ''}${worth}. ${first_sentence(p.fix)}`
		});
	}
	// the work for nothing, from the drill (topmost rows whose every key is unread)
	const unread: { label: string; ms: number; keys: string[]; at?: string; line?: boolean }[] = [];
	const walk = (d: DrillShape) => {
		if (d.fills?.length && d.fills.every((f) => !f.read)) {
			// a wait row has no place of its own: the line that made the call is the one to edit
			const first_line = (m: DrillShape): string | undefined => {
				for (const c of m.children ?? []) {
					const at = c.kind === 'line' && c.at ? c.at : first_line(c);
					if (at) return at;
				}
				return undefined;
			};
			const at = d.at ?? first_line(d);
			unread.push({
				label: d.label,
				ms: d.ms,
				keys: d.fills.map((f) => f.key),
				...(at ? { at } : {}),
				...(d.kind === 'line' || (!d.at && at) ? { line: true } : {})
			});
			return;
		}
		for (const c of d.children ?? []) walk(c);
	};
	if (r.drill) walk(r.drill);
	// one step per set of keys: the same unread data in several rows (the helper's CPU, the line it was
	// inlined onto, its garbage) is one deletion — its rows added up, named by the biggest
	const by_keys = new Map<string, (typeof unread)[number]>();
	for (const u of [...unread].sort((a, b) => b.ms - a.ms)) {
		const k = u.keys.join(', ');
		const had = by_keys.get(k);
		if (!had) by_keys.set(k, { ...u });
		else {
			had.ms += u.ms;
			// the place to edit is a LINE that fills the key (the load's `const freshest = …`), not
			// where a helper it calls starts
			if (u.line && u.at && !had.line) {
				had.at = u.at;
				had.line = true;
			}
		}
	}
	for (const u of [...by_keys.values()].filter((x) => x.ms >= 1)) {
		steps.push({
			value: u.ms,
			key: `unread:${u.keys.join(', ')}`,
			text: `**Delete work for data nothing reads** — ${u.label}${u.at ? ` (\`${u.at}\`)` : ''} builds only ${u.keys.join(', ')}: ~${Math.round(u.ms * 10) / 10}ms per render. Drop it from the load, or the key with it.`
		});
	}
	// the page waiting on its layout for data it first uses later (source-read)
	const chain = (r.findings ?? []).find(
		(f) => f.code === 'parent-chain' && (f.message ?? '').includes('never needed the layout')
	);
	if (chain) {
		const ms = Number((chain.message ?? '').match(/\(([\d.]+) ms later\)/)?.[1] ?? 0);
		steps.push({ value: ms, text: `**Move \`await parent()\` down** — ${chain.message}` });
	}
	if (!steps.length) return '';
	// IN THE FORECAST'S ORDER, WITH THE RENDER AFTER EACH: the forecast counted each saving once (a
	// fix another covers folds into it) and ranked them; every step says what one render takes once
	// it and every step above it are done — where to stop reads off the list. What the forecast does
	// not count (memory, a freshness decision, the parent chain) keeps its own place: a leak that
	// crashes the server still leads
	const parts = r.forecast?.parts ?? [];
	if (parts.length) {
		const key_of = (p: (typeof parts)[number]) =>
			p.kind === 'unread-work' ? `unread:${p.title.slice(p.title.indexOf('(') + 1, -1)}` : p.title;
		const rank = new Map(parts.map((p, i) => [key_of(p), i]));
		const covered = new Set(
			parts.flatMap((p) =>
				(p.with ?? []).map((w) =>
					w.startsWith('Delete work for data nothing reads (')
						? `unread:${w.slice(w.indexOf('(') + 1, -1)}`
						: w
				)
			)
		);
		const kept: Step[] = [];
		for (const s of steps) {
			const i = s.key === undefined ? undefined : rank.get(s.key);
			if (i === undefined) {
				// covered by another step: said there, not again
				if (s.key !== undefined && covered.has(s.key)) continue;
				// not a time saving the forecast counts: after the counted ones (a severe leak stays first)
				kept.push({ ...s, value: s.value === Infinity ? Infinity : -1 / (1 + s.value) });
				continue;
			}
			const p = parts[i];
			const also = p.with?.length ? ` Also covers: ${p.with.join('; ')}.` : '';
			const after =
				p.after_ms !== undefined
					? ` → ~${Math.round(p.after_ms)}ms per render after this and the steps above.`
					: '';
			kept.push({ ...s, value: 1e9 - i, text: `${s.text}${also}${after}` });
		}
		steps.length = 0;
		steps.push(...kept);
	}
	return steps
		.sort((a, b) => b.value - a.value)
		.slice(0, 8)
		.map((s, i) => `${i + 1}. ${s.text}`)
		.join('\n');
}

/** THE PATTERNS as an agent reads them: what, where (with the code and the caller lines), the fix */
function render_patterns(r: ProfileReport): string {
	// a CPU pattern's saving adds up every profiled render; a wait's is one render: per render here
	const n = Math.max(1, r.target?.runs?.length ?? 1);
	const per = (p: { save_ms?: number; wait?: boolean }) =>
		Math.round(((p.save_ms ?? 0) / (p.wait ? 1 : n)) * 100) / 100;
	return (r.patterns ?? [])
		.slice(0, 8)
		.map((p, i) => {
			const sites = (p.sites ?? [])
				.slice(0, 4)
				.map((s) => {
					const via = (s.via ?? [])
						.slice(0, 3)
						.map(
							(v) =>
								`\n      ← called from ${v.file}:${v.line}${v.in_loop ? ' (in a loop)' : ''}: \`${v.code ?? ''}\``
						)
						.join('');
					// what the service's own Cache-Control allows, for a same-answer site
					const uc = s.upstream_cache;
					const said = uc?.no_store
						? ' (the service says no-store: check before caching)'
						: uc?.no_cache
							? ' (the service says revalidate every reuse: cache only with a check, e.g. its ETag)'
							: uc?.max_age
								? ` (the service allows caching ${uc.max_age}s${uc.private ? ', per user' : ''})`
								: uc?.private
									? ' (the service marks it private: per user only)'
									: '';
					// the change, written out: replace these lines with this
					const rw = s.rewrite
						? `\n      Change at ${s.rewrite.file}:${s.rewrite.line}, replace:\n\`\`\`\n${s.rewrite.before}\n\`\`\`\n      with:\n\`\`\`\n${s.rewrite.after}\n\`\`\``
						: '';
					const loc = s.module ? `${s.module} (built ${s.file}:${s.line})` : `${s.file}:${s.line}`;
					return `\n   - ${loc}: \`${s.code ?? ''}\`${said}${via}${rw}`;
				})
				.join('');
			const whole = p.kind === 'same-document' || p.kind === 'almost-same-document';
			const save = p.save_ms
				? ` — saves ~${per(p)}ms${whole ? ' (the whole render, from a cache)' : p.wait ? ' of waiting' : ''} per render`
				: '';
			const example = p.example?.after
				? `\n   Example: \`${p.example.before ?? ''}\` → \`${(p.example.after ?? '').split('\n').join(' ')}\``
				: '';
			return `${i + 1}. **${p.title}**${save}\n   ${p.evidence ?? ''}${sites}\n   Fix: ${p.fix ?? ''}${example}`;
		})
		.join('\n');
}

/** THE LEDGER as an agent reads it: one line of code per row, with every cost on it */
type DrillShape = {
	label: string;
	ms: number;
	kind: string;
	at?: string;
	calls?: number;
	alone?: number;
	runs?: [number, number];
	cold?: number;
	split?: {
		calls: number;
		theirs_ms?: number;
		told?: number;
		network_ms: number;
		body_ms: number;
		top?: { name: string; ms: number }[];
	};
	fills?: { key: string; read: boolean }[];
	why?: string[];
	children?: DrillShape[];
};

/** THE DRILL-DOWN as an agent reads it: an indented tree to the line (four levels below the
 *  render: phase, load file, who, line), each row with the patterns found on it */
function render_drill(root: DrillShape): string {
	const KIND: Record<string, string> = {
		cpu: 'CPU',
		wait: 'waiting',
		gap: 'nothing recorded',
		lane: 'load file'
	};
	const out: string[] = [];
	const walk = (n: DrillShape, depth: number) => {
		// alone = nothing else in flight: the least a faster answer saves
		const alone =
			n.alone === undefined
				? ''
				: n.alone < 0.05
					? ', always beside other calls'
					: n.alone >= n.ms - 0.05
						? ', alone'
						: `, ${n.alone}ms alone`;
		// its low–high over the renders: a difference inside it is noise
		const spread =
			(n.runs
				? `, ${n.kind === 'wait' ? 'calls took ' : ''}${n.runs[0]}–${n.runs[1]}ms over renders`
				: '') + (n.cold !== undefined ? `, ${n.cold}ms cold` : '');
		const kind = KIND[n.kind]
			? ` [${KIND[n.kind]}${n.calls && n.calls > 1 ? `, ${n.calls} ${n.kind === 'cpu' ? 'renders' : 'calls'}` : ''}${alone}${spread}]`
			: '';
		const at = n.at && n.kind !== 'line' && n.kind !== 'lane' ? ` @ ${n.at}` : '';
		const why = n.why?.length ? ` — ${n.why.join(', ')}` : '';
		// the page-data keys it feeds; all unread = its time bought nothing
		const all_unread = !!n.fills?.length && n.fills.every((f) => !f.read);
		const fills = n.fills?.length
			? ` → ${n.fills.map((f) => (f.read || all_unread ? f.key : `${f.key} (unread)`)).join(', ')}${all_unread ? ' (NOTHING READS IT)' : ''}`
			: '';
		// an HTTP wait: each call's own clock, averaged — their side (Server-Timing), the rest, the body
		const sp = n.split;
		const per = (ms: number) => Math.round((ms / (sp?.calls || 1)) * 10) / 10;
		const split = sp
			? ` {${sp.calls > 1 ? 'each call' : 'the call'}: ${
					sp.theirs_ms !== undefined
						? `${per(sp.theirs_ms)}ms their side${sp.top ? ` (${sp.top.map((t) => `${t.name} ${per(t.ms)}`).join(', ')})` : ''}${sp.told && sp.told < sp.calls ? ` on ${sp.told} of ${sp.calls}` : ''}, ${per(sp.network_ms)}ms network & the rest`
						: `${per(sp.network_ms)}ms until headers`
				}, ${per(sp.body_ms)}ms body}`
			: '';
		// a helper line: the lines of yours that called it, inline
		const from =
			n.kind === 'line' && n.children?.length
				? ` ← called from ${n.children.map((c) => `${c.at ?? c.label} (${c.ms}ms)`).join(', ')}`
				: '';
		out.push(
			`${'  '.repeat(depth)}- ${n.kind === 'line' ? (n.at ?? n.label) : n.label}: ${n.ms}ms${kind}${at}${split}${from}${fills}${why}`
		);
		// a folded "N more" keeps its rows for the page and the sums; the digest names the fold only
		if (depth < 3 && n.kind !== 'line' && n.kind !== 'more')
			for (const c of n.children ?? []) walk(c, depth + 1);
	};
	for (const c of root.children ?? []) walk(c, 0);
	return out.join('\n');
}

function render_ledger(r: ProfileReport): string {
	// CPU, bytes and GC add up every profiled render: per render here, like the render time
	const n = Math.max(1, r.target?.runs?.length ?? 1);
	const ms = (x: number) => Math.round((x / n) * 100) / 100;
	return (r.ledger ?? [])
		.slice(0, 10)
		.map((l) => {
			const costs: string[] = [];
			if (l.cpu_ms) costs.push(`${ms(l.cpu_ms)}ms CPU`);
			if (l.lib_ms)
				costs.push(
					`${ms(l.lib_ms)}ms inside ${
						(l.libs ?? [])
							.map((x) => x.name)
							.slice(0, 2)
							.join(', ') || 'libraries'
					}`
				);
			if (l.alloc_bytes) costs.push(`${kb_or_mb(l.alloc_bytes / n)} allocated`);
			if (l.gc_ms) costs.push(`${ms(l.gc_ms)}ms GC`);
			if (l.retained_bytes) costs.push(`${kb_or_mb(l.retained_bytes)} kept`);
			if (l.merged)
				costs.push(`CPU moved here from line ${l.merged.from} (V8 had inlined ${l.merged.callee})`);
			return `- ${l.file}:${l.line} — ${costs.join(', ')}${l.code ? `\n  \`${l.code}\`` : ''}`;
		})
		.join('\n');
}

/** exported for the tests only (mcp.ts is not a package entry) */
export function render_profile(origin: string, r: ProfileReport): string {
	const target = r.target?.page ?? r.target?.request ?? '(unknown)';
	const runs = r.target?.runs ?? [];
	const s = r.summary ?? {};
	// PER RENDER: the profile's CPU, budget and function times add up every run; the render time,
	// the ledger and the patterns are one render. An agent reads them side by side, so every section
	// here is one render's worth.
	const n = Math.max(1, runs.length);
	const per = (ms: number | undefined) => Math.round(((ms ?? 0) / n) * 100) / 100;
	const head =
		`# SSR profile — ${target}${runs.length ? ` · ${runs.length} run(s)` : ''}\n\n` +
		`**${s.verdict ?? 'profiled'}** · render p50 ~${median(runs).toFixed(2)}ms` +
		(runs.length ? ` (runs: ${runs.join(', ')})` : '') +
		(s.busy_ms != null
			? ` · CPU busy ${per(s.busy_ms)}ms per render (${s.busy_pct}% of the window)`
			: '') +
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
		.map((b) => `- ${b.label}: ${per(b.ms)}ms (${(((b.ms ?? 0) / kept_total) * 100).toFixed(1)}%)`)
		.join('\n');
	const budget_title = r.dev
		? 'Where the time went (per render; Vite + profiler overhead excluded; % of remaining app time)'
		: 'Where the time went (per render, profiler overhead excluded)';

	// Hottest functions that aren't profiler noise, by self time.
	const hot = (r.hot_functions ?? [])
		.filter((h) => h.category !== 'profiler')
		.sort((a, b) => (b.self_ms ?? 0) - (a.self_ms ?? 0))
		.slice(0, 8)
		.map((h, i) => {
			// the heaviest call path into it, nearest caller first — enough to place it without the flame
			const top = h.stacks?.[0];
			const via = top?.frames?.length
				? `\n   ← ${top.frames
						.slice(0, 5)
						.map((f) => f.replace(/ \(.*\)$/, ''))
						.join(' ← ')}${top.frames.length > 5 ? ' ← …' : ''}`
				: '';
			return `${i + 1}. ${h.label ? `fn \`${h.label}\`` : h.name} — ${per(h.self_ms)}ms self${h.category ? ` [${h.category}]` : ''}${h.file ? ` · ${base(h.file)}${h.line ? `:${h.line}` : ''}` : ''}${via}`;
		})
		.join('\n');

	const comps = (r.components ?? [])
		.sort((a, b) => (b.self_ms ?? 0) - (a.self_ms ?? 0))
		.slice(0, 10)
		.map(
			(c) =>
				`- ${c.name} ×${c.instances ?? 1} — ${per(c.self_ms)}ms self${c.alloc_bytes ? `, ${Math.round(c.alloc_bytes / 1024)} KB alloc` : ''}`
		)
		.join('\n');

	const net = r.network;
	const net_line = net
		? `${net.count ?? 0} call(s)${net.total_ms ? `, ${net.total_ms}ms total` : ''}${net.errors ? `, ${net.errors} error(s)` : ''}`
		: 'n/a';
	const mem = r.memory;
	const mem_line = mem ? `RSS ${mem.rss_start_mb}→${mem.rss_end_mb} MB (+${mem.growth_mb})` : 'n/a';

	const links = r.links
		? `\n\nFull report: ${origin}${r.links.html}${r.links.json ? ` · JSON: ${origin}${r.links.json}` : ''}${r.links.cpuprofile ? ` · .cpuprofile: ${origin}${r.links.cpuprofile}` : ''}`
		: '';

	// CPU pattern numbers add up every profiled render; waits are one render's
	// the report's forecast counts fixes on the same lines once and adds deleted work; an older
	// report: the plain sum, waits capped at the render's waiting
	const fc = r.forecast;
	const impact = fc
		? undefined
		: fix_impact(
				(r.patterns ?? []).map((p) => ({ save_ms: p.save_ms ?? 0, wait: p.wait })),
				median(runs),
				runs.length || 1,
				r.timeline?.wait_ms
			);
	const covered = (fc?.parts ?? []).filter((p) => p.with?.length);
	const forecast_line =
		fc && fc.now_ms > fc.after_ms
			? `Doing all of it: ~${Math.round(fc.now_ms)}ms → ~${Math.round(fc.after_ms)}ms per render (−${Math.round(((fc.now_ms - fc.after_ms) / fc.now_ms) * 100)}%: ${[fc.cpu_ms ? `${fc.cpu_ms}ms CPU` : '', fc.wait_ms ? `${fc.wait_ms}ms waiting` : '', fc.delete_ms ? `${fc.delete_ms}ms of work for unread data` : ''].filter(Boolean).join(', ')}).${covered.length ? ` Counted once: ${covered.map((p) => `"${p.title}" covers ${p.with!.map((w) => `"${w}"`).join(', ')}`).join('; ')}.` : ''}${fc.answers ? ` Keeping the services' answers between renders too (a freshness decision: only where a slightly stale answer is fine): ~${Math.round(fc.answers.after_ms)}ms${fc.answers.measured ? ` (measured: the page rendered in ${Math.round(fc.answers.measured.ms)}ms with those answers served from memory, then the other fixes taken off)` : ''}.` : ''}${fc.cpu_now_ms && fc.cpu_after_ms && fc.cpu_after_ms < fc.cpu_now_ms * 0.9 ? ` Capacity: main-thread CPU ${Math.round(fc.cpu_now_ms)}ms → ~${Math.round(fc.cpu_after_ms)}ms a render after the CPU fixes, so one core serves ~${Math.round(1000 / fc.cpu_now_ms)} → ~${Math.round(1000 / fc.cpu_after_ms)} renders a second (waiting fixes cut latency, not this).` : ''}${fc.cache ? ' A cached copy of the whole document is a separate lever, not counted.' : ''}${fc.clamped ? ' (The savings claimed more waiting or CPU than the render had: held at what it used.)' : ''}${fc.partial ? ' Built without sourcemaps: fewer lines seen, so fewer fixes counted; the real time after them is likely lower.' : ''}\n`
			: impact
				? `Fixing all of these takes ~${Math.round(impact.render_ms - impact.after_ms)}ms off the ${Math.round(impact.render_ms)}ms render (${impact.pct}%).\n`
				: '';
	const patterns = forecast_line + render_patterns(r);
	const ledger = render_ledger(r);
	const plan = render_plan(r);
	// SINCE THE LAST PROFILE of this page: did the change pay (what an agent iterating on a fix asks first)
	const sn = r.since;
	const since = !sn
		? ''
		: sn.order
			? `Run order skews this: both ran on one server after renders that kept ${sn.order.kept_mb} MB alive each; restart between profiles to compare.`
			: sn.same
				? `No real change since the last profile (${sn.a_ms} → ${sn.b_ms}ms, within the runs' own spread).`
				: `${sn.b_ms !== undefined && sn.a_ms !== undefined ? `${sn.b_ms - sn.a_ms > 0 ? '+' : ''}${Math.round((sn.b_ms - sn.a_ms) * 10) / 10}ms since the last profile (${sn.a_ms} → ${sn.b_ms}ms)` : 'Since the last profile'}${sn.moved.length ? ', mostly:\n' + sn.moved.map((m) => `- ${m.status} ${m.path[m.path.length - 1]}${m.at && m.kind !== 'line' ? ` @ ${m.at}` : ''}: ${m.d_ms > 0 ? '+' : ''}${m.d_ms}ms`).join('\n') : '.'}${sn.fix_check ? `\nThe fixed patterns promised ~${sn.fix_check.predicted_ms}ms; the render moved ${sn.fix_check.measured_ms}ms (${sn.fix_check.verdict}).` : ''}`;
	return (
		head +
		dev_note +
		(since
			? `\n\n## Since your last profile of this page\n${since}` +
				(sn?.score && sn.score.a !== sn.score.b
					? `\nScore ${sn.score.a} → ${sn.score.b} (${sn.score.a_grade} → ${sn.score.b_grade})${sn.score.moved.length ? ': ' + sn.score.moved.map((m) => `${m.label} ${m.a} → ${m.b}`).join(', ') : ''}.`
					: '')
			: '') +
		// the forecast heads the plan (said once); an older report's plain sum stays with the patterns
		(plan
			? `\n\n## Do this, in order (each: where to edit, and what it is worth)\n${fc ? forecast_line : ''}${plan}`
			: '') +
		// the same slow line on other profiled pages: fixed once, all of them faster
		(r.shared?.length
			? `\n\n## These fixes make other pages faster too\n${r.shared
					.map(
						(f) =>
							`- \`${f.where}:${f.line}\` (${f.title}): ${f.pages.map((p) => `${p.page} ~${Math.round(p.ms * 10) / 10}ms`).join(', ')}; ~${Math.round(f.total_ms * 10) / 10}ms per render in all`
					)
					.join('\n')}`
			: '') +
		(patterns
			? `\n\n## Slow patterns (fix these first)\n${plan && fc ? render_patterns(r) : patterns}`
			: '') +
		(r.drill
			? `\n\n## Where one render went (${r.drill.ms}ms, down to the line; every level adds up)\n${render_drill(r.drill)}`
			: '') +
		(ledger ? `\n\n## The exact lines (your code, costliest first, per render)\n${ledger}` : '') +
		(findings ? `\n\n## Findings\n${findings}` : '') +
		(budget ? `\n\n## ${budget_title}\n${budget}` : '') +
		(hot ? `\n\n## Hottest functions (self ms per render)\n${hot}` : '') +
		(comps
			? `\n\n## Components (self ms per render; ×N = renders of it in one page render)\n${comps}`
			: '') +
		`\n\n## Network: ${net_line}  ·  Memory: ${mem_line}` +
		links
	);
}

/** Record an SSR profile of a route on the running app + return the digested findings. */
// Where a local SvelteKit app usually listens — probed (preview first: real numbers) when the caller
// gives a bare path instead of a full URL, so an agent can just say "profile /fr/fr".
const LOCAL_PORTS = [4173, 5173, 3000, 5174, 4174, 3001, 8080, 4321, 5175];

/** fetch with a hard deadline — a hung server can't wedge the tool. */
async function fetch_timeout(url: string | URL, opts: RequestInit, ms: number): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms);
	try {
		return await fetch(url, { ...opts, signal: ac.signal });
	} finally {
		clearTimeout(t);
	}
}

/** Probe localhost ports in parallel for a MOUNTED profiler; returns hits in priority order. */
async function find_local_profiler(base: string, key: string): Promise<string[]> {
	const key_h: Record<string, string> = key ? { 'x-profiler-key': key } : {};
	const probes = LOCAL_PORTS.map(async (port) => {
		const origin = `http://localhost:${port}`;
		try {
			const r = await fetch_timeout(origin + base, { redirect: 'manual', headers: key_h }, 700);
			// 404 = no profiler here (bare Kit 404s that path). 200/401/30x = profiler answering.
			return r.status !== 404 ? origin : null;
		} catch {
			return null; // nothing listening / not http — skip
		}
	});
	return (await Promise.all(probes)).filter((o): o is string => !!o);
}

const NOT_MOUNTED = (base: string, where: string) =>
	`The profiler is not mounted at ${base} on ${where}. Turn it on in vite.config.ts:\n\n` +
	`  ogygia({ profiler: true /* or { secret, path, … } */ })\n\n` +
	`ogygia.handle() mounts it for you — no hooks wiring needed. Restart the server, then retry.`;

async function tool_profile(args: Attrs): Promise<ToolResult> {
	const raw = String(args.url ?? '').trim();
	if (!raw)
		return fail(
			'`url` is required — a route path like `/fr/fr` (profiles your local running server), or a full URL like `https://app.com/fr/fr` (profiles that host).'
		);
	const profiler_base = String(args.base ?? '/__profiler').replace(TRAILING_SLASH_RE, '');
	const runs = typeof args.runs === 'number' ? Math.min(Math.max(Math.round(args.runs), 1), 50) : 5;
	const key = typeof args.key === 'string' ? args.key : '';
	const explicit_origin =
		typeof args.origin === 'string' && args.origin
			? args.origin.replace(TRAILING_SLASH_RE, '')
			: '';

	// Resolve WHERE to profile. Full URL → that host. Bare path → the given `origin`, else ASK the user
	// for the URL (they would rather name the host than have us guess) — offering any local server we see.
	let origin: string;
	let route: string;
	if (HTTP_URL_RE.test(raw)) {
		const u = new URL(raw);
		origin = u.origin;
		route = u.pathname + u.search;
	} else {
		route = raw.startsWith('/') ? raw : '/' + raw;
		if (explicit_origin) {
			origin = explicit_origin;
		} else {
			const hits = await find_local_profiler(profiler_base, key);
			const suggest = hits.length
				? `\n\nRunning locally right now with the profiler mounted — reply with one to use it:\n${hits.map((h) => `  • ${h}${route}`).join('\n')}`
				: `\n\n(No local server with the profiler is up — start \`vite dev\` / \`vite preview\`, or give a remote URL.)`;
			return fail(
				`Which URL should I profile \`${route}\` on? Ask the user, then call ogygia_profile again with the full \`url\`.\n\n` +
					`Local looks like http://localhost:5173${route}; remote like https://your-app.com${route}.${suggest}`
			);
		}
	}

	// Confirm the profiler is mounted AND we're authed — clean messages beat a cryptic failure. A locked
	// profiler serves its login PAGE at 200 (not 401), so sniff for it: no key → ask for one, wrong key
	// → say so, before we bother recording.
	{
		const key_h: Record<string, string> = key ? { 'x-profiler-key': key } : {};
		let pre: Response;
		try {
			pre = await fetch_timeout(
				origin + profiler_base,
				{ redirect: 'manual', headers: key_h },
				8000
			);
		} catch (e) {
			return fail(
				`Could not reach ${origin} — is it running and reachable? (${e instanceof Error ? e.message : String(e)})`
			);
		}
		if (pre.status === 404) return fail(NOT_MOUNTED(profiler_base, origin));
		const pre_body = await pre.text().catch(() => '');
		if (LOGIN_FORM_RE.test(pre_body))
			return fail(
				key
					? `The profiler on ${origin} rejected that \`key\` (still locked). Confirm its secret with the user.`
					: `The profiler on ${origin} is locked. Ask the user for its secret and pass it as \`key\`.`
			);
	}

	const record_once = () => {
		const rec = new URL(origin + profiler_base + '/page');
		rec.searchParams.set('p', route);
		rec.searchParams.set('format', 'json');
		rec.searchParams.set('runs', String(runs));
		const headers: Record<string, string> = { accept: 'application/json' };
		if (key) headers['x-profiler-key'] = key;
		// N heavy renders can be slow — give it room, but never hang forever.
		return fetch_timeout(rec, { headers }, 90_000);
	};

	let res: Response;
	try {
		res = await record_once();
	} catch (e) {
		const aborted = e instanceof Error && e.name === 'AbortError';
		return fail(
			aborted
				? `Recording ${route} on ${origin} took over 90s and was aborted. Try fewer \`runs\`, or if this host times out (serverless), download the .ogp from ${origin}${profiler_base} and open it with ogygia_profile_open.`
				: `Recording failed: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	// Stuck-session self-heal: a run abandoned by a crashed/timed-out request leaves a 409. Clear it
	// via /reset (which we own) and retry ONCE — the agent shouldn't have to wait out the 2-min auto-heal.
	if (res.status === 409) {
		try {
			const reset = new URL(origin + profiler_base + '/reset');
			const reset_h: Record<string, string> = key ? { 'x-profiler-key': key } : {};
			await fetch_timeout(reset, { redirect: 'manual', headers: reset_h }, 5000);
			res = await record_once();
		} catch {
			/* fall through to the 409 message below */
		}
	}

	if ((res.headers.get('content-type') ?? '').includes('application/json')) {
		return text(render_profile(origin, (await res.json()) as ProfileReport));
	}
	const body = (await res.text()).replace(HTML_TAG_G, ' ').replace(WS_G, ' ').trim().slice(0, 300);
	if (res.status === 409)
		return fail(
			`A profile is already running on ${origin} and /reset didn’t clear it. It auto-heals after ~2 min — wait and retry.`
		);
	if (res.status === 401 || res.status === 403)
		return fail(
			`The profiler on ${origin} is locked. Pass its secret as \`key\` (ask the user for it).`
		);
	return fail(
		`profiler did not return JSON (HTTP ${res.status}). ${body || '(check the profiler key / route path)'}`
	);
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

	// report_json's return is a superset of the loose ProfileReport view render_profile reads.
	const report = report_json(
		dump.analysis,
		dump.meta,
		'/__profiler',
		dump.extras
	) as unknown as ProfileReport;
	report.links = undefined; // the source server is gone — its report URLs would 404
	const node = (dump.meta as { node?: string }).node;
	return text(
		`> Imported from \`${file}\`${node ? ` · Node ${node}` : ''}\n\n` + render_profile('', report)
	);
}

// ── ogygia_observatory — bundle files into a client-only Observatory link ──────────────────────────

const DEFAULT_OBSERVATORY = 'https://ogygia.puruvj.dev/observatory';

/** `#<base64url(gzip(json))>` — the EXACT single-string format the Observatory decodes (browser gunzip).
 *  The payload is `{ f: files }` (files only; the app fills in default UI state). */
function observatory_link(files: Record<string, string>, base: string): string {
	const gz = gzipSync(Buffer.from(JSON.stringify({ f: files }), 'utf8'));
	const b64url = gz
		.toString('base64')
		.replace(PLUS_G, '-')
		.replace(SLASH_G, '_')
		.replace(TRAILING_EQUALS_RE, '');
	return `${base.replace(HASH_SUFFIX_RE, '')}#${b64url}`;
}

function tool_observatory(args: Attrs): ToolResult {
	let files: Record<string, string> = {};
	if (args.files && typeof args.files === 'object' && !Array.isArray(args.files)) {
		for (const [k, v] of Object.entries(args.files as Record<string, unknown>))
			if (typeof v === 'string') files[k] = v;
	} else if (typeof args.source === 'string') {
		files[String(args.filename ?? 'App.svelte')] = args.source;
	}
	const names = Object.keys(files);
	if (!names.length)
		return fail(
			'Provide `files` (a map of filename → source) or `source` (+ optional `filename`).'
		);
	if (!names.some((n) => n.endsWith('.svelte')))
		return text(
			`⚠️ No .svelte file given — the Observatory renders a Svelte component (App.svelte is the entry). Add one.\n\nFiles: ${names.join(', ')}`
		);

	const base = String(args.base ?? DEFAULT_OBSERVATORY);
	const url = observatory_link(files, base);
	const long =
		url.length > 8000
			? `\n\n⚠️ The link is ${url.length} chars — some tools truncate very long URLs. Trim to the files that matter if it breaks.`
			: '';
	return text(
		`Open this in the ogygia Observatory to see ${names.length === 1 ? 'this component' : `these ${names.length} files`} compiled live — the island map, byte ledger, wire payloads, and a real hydrating preview:\n\n` +
			`${url}\n\n` +
			`🔒 Client-only: the code is packed into the URL's **# fragment**, which browsers NEVER send to a server — nothing here touches ogygia's (or anyone's) servers. It compiles entirely in your browser.${long}`
	);
}

// ── ogygia_scan — walk a real project, map every island + lint the whole codebase ──────────────────

const SKIP_DIRS = new Set([
	'node_modules',
	'.svelte-kit',
	'.git',
	'dist',
	'build',
	'.vercel',
	'.netlify',
	'coverage'
]);

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

type ScanIsland = {
	component: string;
	local: string;
	kind: string;
	strategy: string;
	attrs: Attrs;
	file: string;
};
type Violation = { file: string; severity: 'error' | 'warn'; msg: string };

function tool_scan(args: Attrs): ToolResult {
	const dir = String(args.dir ?? 'src');
	const root = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
	const files = walk_svelte(root);
	if (!files.length)
		return fail(
			`No .svelte files found under ${dir} (cwd: ${process.cwd()}). Pass \`dir\` (e.g. "src" or "src/routes").`
		);

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
			const r = transformHost(
				source,
				'/' + rel(f).replace(BACKSLASH_G, '/'),
				build_ctx(true)
			) as HostResult;
			for (const isl of r?.islands ?? [])
				if (isl.componentPath) kind_by_component.set(base(isl.componentPath), isl.kind ?? '');
		} catch (e) {
			const raw = (e instanceof Error ? e.message : String(e)).replace(WS_G, ' ').trim();
			// "unknown preset" is a scan limitation (we don't load the app's ogygia({ regions: { presets } })
			// config), not a real violation — count it for a footnote instead of flagging it.
			if (UNKNOWN_PRESET_RE.test(raw)) preset_marks++;
			else violations.push({ file: rel(f), severity: 'error', msg: raw });
		}

		for (const m of marks) {
			const kind = kind_by_component.get(base(m.component)) ?? '(mark only)';
			islands.push({
				component: m.component,
				local: m.local,
				kind,
				strategy: strategy_label(m.attrs),
				attrs: m.attrs,
				file: rel(f)
			});
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			// a real interactive island (not a lake/raw) — remember its component basename
			if (m.attrs.wake !== 'none' && m.attrs.region !== 'raw')
				island_components.add(base(m.component));

			// ── soft lints (per mark) ──
			if (m.attrs.wake === 'none' && m.attrs.render === 'deferred')
				violations.push({
					file: rel(f),
					severity: 'warn',
					msg: `${m.component}: wake:'none' + render:'deferred' is nonsense (HTML later, no JS) — dev treats it as defer-only. Drop one.`
				});
		}
	}

	// ── cross-file lint: island-in-island — a file that IS used as an island AND marks its own islands.
	for (const { marks, file } of per_file) {
		const this_base = base(file).replace(SVELTE_EXT_RE, '');
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

	if (!islands.length)
		return text(
			`Scanned ${files.length} .svelte file(s) under ${dir} — no marked regions. The whole tree is free server HTML.`
		);

	const by_file = new Map<string, ScanIsland[]>();
	for (const i of islands) (by_file.get(i.file) ?? by_file.set(i.file, []).get(i.file)!).push(i);
	const map_lines = [...by_file.entries()]
		.map(
			([file, list]) =>
				`### ${file}\n${list.map((i) => `- ${i.component} (as ${i.local}) — ${i.strategy}`).join('\n')}`
		)
		.join('\n\n');
	const kind_summary = Object.entries(kinds)
		.map(([k, n]) => `${n} ${k}`)
		.join(' · ');
	const errs = violations.filter((v) => v.severity === 'error');
	const warns = violations.filter((v) => v.severity === 'warn');
	const vio_block = violations.length
		? `\n\n## ⚠️ Findings (${violations.length})\n` +
			[...errs, ...warns]
				.map((v) => `- ${v.severity === 'error' ? '❌' : '⚠️'} ${v.file}: ${v.msg}`)
				.join('\n')
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

// ── flags: the build's own AST collector, run live over src/ ─────────────────────────────────

function walk_flag_files(dir: string, out: string[] = [], depth = 0): string[] {
	if (depth > 12 || out.length > 3000) return out;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith('.')) continue;
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) walk_flag_files(path.join(dir, e.name), out, depth + 1);
		} else if (
			(e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) ||
			e.name.endsWith('.svelte')
		) {
			out.push(path.join(dir, e.name));
		}
	}
	return out;
}

function tool_flags(args: Attrs): ToolResult {
	const dir = String(args.dir ?? '.');
	const root = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);

	// The last build's inventory, when this project has one (client build writes it).
	let manifest: { flags: FlagSite[]; names: string[] } | null = null;
	try {
		manifest = JSON.parse(
			readFileSync(path.join(root, 'node_modules', '.ogygia', 'flags-manifest.json'), 'utf8')
		) as { flags: FlagSite[]; names: string[] };
	} catch {
		manifest = null;
	}

	// Live scan — same collector the build runs (AST-resolved 'ogygia' imports, literal names).
	const files = walk_flag_files(path.join(root, 'src'));
	const sites: FlagSite[] = [];
	for (const f of files.slice(0, 3000)) {
		let source: string;
		try {
			source = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		const rel = path.relative(root, f).replace(BACKSLASH_G, '/');
		sites.push(...collect_flag_sites(source, rel, rel));
	}
	const live = flags_manifest(sites);

	if (!live.flags.length && !manifest)
		return text(
			`No flag() call sites under ${dir}/src (${files.length} file(s) scanned), and no ` +
				`build manifest. Flags are defined with \`flag('name', …)\` from 'ogygia/flag' ` +
				`— literal names only (a dynamic first argument is invisible to the inventory).`
		);

	const by_name = new Map<string, FlagSite[]>();
	for (const s of live.flags) {
		const k = `${s.name} (${s.kind})`;
		const list = by_name.get(k) ?? [];
		if (!list.length) by_name.set(k, list);
		list.push(s);
	}
	const site_lines = [...by_name.entries()]
		.map(([k, list]) => `### ${k}\n${list.map((s) => `- ${s.file}:${s.line}`).join('\n')}`)
		.join('\n\n');

	const live_names = new Set(live.names);
	const stale = manifest ? manifest.names.filter((n) => !live_names.has(n)) : [];
	const manifest_note = !manifest
		? `\n\n> No build manifest yet — node_modules/.ogygia/flags-manifest.json appears after a client build.`
		: stale.length
			? `\n\n> ⚠️ In the last build's manifest but NOT in source now (deleted or renamed since): ${stale.join(', ')}. Rebuild to refresh.`
			: `\n\n> Matches the last build's manifest.`;

	return text(
		`# ogygia flags — ${dir}\n\n` +
			`${live.names.length} flag(s) · ${live.flags.length} call site(s) across ${files.length} scanned file(s)\n\n` +
			site_lines +
			manifest_note +
			`\n\n> Override in dev: \`?og-exp=<name>:<variant>\` (repeat or comma-separate). Prod honors overrides only behind \`decide({ overrides })\`.`
	);
}

// ── fragment: probe a federation MFE origin ──────────────────────────────────────────────────

async function tool_fragment(args: Attrs): Promise<ToolResult> {
	const raw = String(args.origin ?? '');
	if (!raw) return fail('Pass `origin` — the MFE origin to probe (e.g. https://cms.internal).');
	let origin: string;
	try {
		origin = new URL(raw).origin;
	} catch {
		return fail(`Not a valid origin: ${raw}`);
	}
	const get = async (url: string): Promise<Response | null> => {
		try {
			return await fetch(url, {
				signal: AbortSignal.timeout(10_000),
				headers: { accept: 'application/json' }
			});
		} catch {
			return null;
		}
	};

	// The fixed page endpoint a `federate({ expose })` serves — keep in sync with FRAGMENT_ROUTES_PATH
	// (federation/wire.ts). Deliberately not imported: the MCP must not pull the handle graph.
	const page_res = await get(`${origin}/og/fragment/page?path=${encodeURIComponent('/')}`);
	const posture = !page_res
		? '❌ unreachable (network error / timeout)'
		: page_res.status === 401
			? '🔒 signature-verified — an unsigned request is rejected (good)'
			: page_res.status === 200
				? '⚠️ OPEN — served an UNSIGNED request. Unless this origin is private-network-only, add each caller as a peer with its public `key` in federate({ peers }) (or `open: true` on purpose).'
				: page_res.status === 404
					? 'not exposed here (no /og/fragment/page — page mounting unavailable)'
					: `HTTP ${page_res.status}`;

	const cat_res = await get(`${origin}/og/fragment/__catalog`);
	let widgets_block =
		'No widget catalog (federate({ widgets }) not declared, or not an ogygia fragment origin).';
	if (cat_res?.ok) {
		try {
			const manifest = (await cat_res.json()) as {
				names?: string[];
				widgets?: Record<string, { props?: string[] }>;
			};
			const names = manifest.names ?? [];
			widgets_block = names.length
				? names
						.map((n) => `- \`${n}(${(manifest.widgets?.[n]?.props ?? []).join(', ')})\``)
						.join('\n') +
					`\n\nTyped stubs: \`npx ogygia fragments ${origin} --out src/lib/widgets.ts\` (add \`--check\` in CI to fail on drift).`
				: 'Catalog mounted, zero widgets declared.';
		} catch {
			widgets_block = '__catalog returned non-JSON — not an ogygia widget catalog.';
		}
	}

	return text(
		`# ogygia fragment probe — ${origin}\n\n` +
			`- routes endpoint (\`/og/fragment/page\`): ${posture}\n\n` +
			`## Widgets (\`__catalog\`)\n${widgets_block}`
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
		case 'ogygia_flags':
			return tool_flags(args);
		case 'ogygia_fragment':
			return tool_fragment(args);
		default:
			return fail(`Unknown tool: ${name}`);
	}
}

// ── JSON-RPC 2.0 over stdio ────────────────────────────────────────────────────

type Rpc = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
};

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
			.catch((e) =>
				send({
					jsonrpc: '2.0',
					id,
					result: fail(`Internal error: ${e instanceof Error ? e.message : String(e)}`)
				})
			);
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
	log(
		`ogygia MCP server v${version} ready — ${TOOLS.length} tools (${TOOLS.map((t) => t.name.replace('ogygia_', '')).join(', ')})`
	);
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
