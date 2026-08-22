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

function dispatch_tool(name: string, args: Attrs): ToolResult {
	switch (name) {
		case 'ogygia_compile':
			return tool_compile(args);
		case 'ogygia_islands':
			return tool_islands(args);
		case 'ogygia_check':
			return tool_check(args);
		case 'ogygia_explain':
			return tool_explain(args);
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
		let result: ToolResult;
		try {
			result = dispatch_tool(name, args);
		} catch (e) {
			result = fail(`Internal error: ${e instanceof Error ? e.message : String(e)}`);
		}
		send({ jsonrpc: '2.0', id, result });
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
	log(`ogygia MCP server v${version} ready — 4 tools (compile, islands, check, explain)`);
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
