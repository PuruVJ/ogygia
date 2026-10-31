/**
 * The federation request server — SERVER ONLY (imports the region secret virtuals). The handle
 * delegates every `/og/fragment/*`, `/og/thaw`, and `/og/frag` (deferred hole) request here. Reads
 * the app's registration from `current_federation()`; unregistered apps serve nothing (null).
 *
 * This is the v2 replacement for the v1 `expose()` / `catalog()` / `proxy()` route files: the
 * handle owns all of it, so a `federate()` in hooks.server.ts is the whole wiring.
 */
import { version } from '$app/env';
import type { RequestEvent } from '@sveltejs/kit';
import type { ServerApp } from '@ogygia/core/plugin';
import { current_federation } from './registry.ts';
import { begin_source_capture, broadcast_thaw } from './federate.ts';
import { set_hole_signer } from './hole.ts';
import { fed_app } from './app.ts';
import {
	verify_signed_request,
	attach_claims,
	absolutize,
	lift_document,
	json_response,
	json_error,
	read_capped_body,
	child_traceparent,
	USER_HEADER_NAME,
	FRAGMENT_ROUTES_PATH,
	FRAGMENT_BASE,
	THAW_PATH,
	type Claims,
	type VerifyConfig
} from './wire.ts';
import type { Federation, Peer } from './types.ts';

const HOLE_PATH = '/og/frag';
const HOLE_TTL_MS = 5 * 60_000; // a signed hole URL is good for 5 min (re-minted every render)

/** Every configured peer's public keys — the authorized-caller set for an inbound request. */
function inbound_verify(fed: Federation): VerifyConfig {
	const publicKeys: string[] = [];
	for (const peer of fed.peers.values()) publicKeys.push(...peer.keys);
	return { publicKeys, audience: fed.audience, skewMs: fed.skew_ms };
}

/** The HMAC-signed message for a deferred hole capability (peer + kind + target + search + exp). */
const hole_message = (peer: string, kind: string, target: string, search: string, exp: number) =>
	`frag.${peer}.${kind}.${target}.${search}.${exp}`;

/** Install the hole signer: the app's own region key signs it (`app.sign`). Idempotent. */
export function install_federation(app: ServerApp): void {
	set_hole_signer(({ peer, kind, target, search }) => {
		const exp = Date.now() + HOLE_TTL_MS;
		const sig = app.sign(hole_message(peer, kind, target, search ?? '', exp));
		const q = new URLSearchParams({
			peer,
			kind,
			target,
			search: search ?? '',
			exp: String(exp),
			sig
		});
		return `${HOLE_PATH}?${q}`;
	});
}

// Deploy-thaw: on the first federation request after a boot with a NEW build id, a producer app
// broadcasts a thaw-all so every consumer drops the stored pages that baked its now-stale assets.
// A store plugin keeps the last build it saw (the shared `lastBuild` hook; on a shared store only a
// changed `version` fires). No store plugin: nothing remembers a build, nothing fires.
let deploy_checked = false;
async function maybe_deploy_thaw(fed: Federation): Promise<void> {
	if (deploy_checked || fed.deploy !== 'auto') return;
	deploy_checked = true;
	if (!fed.expose && fed.widgets.size === 0) return; // only producers matter
	try {
		const seen = await fed_app()?.ask.lastBuild(version);
		if (seen !== undefined && seen !== version)
			await broadcast_thaw(fed, { id: crypto.randomUUID(), hop: 0, tags: 'all' });
	} catch {
		/* store unavailable — deploy-thaw is best-effort, the TTL backstop still holds */
	}
}

/** Dispatch a federation request, or null if the path is none of ours. */
export async function serve_federation(event: RequestEvent): Promise<Response | null> {
	const fed = current_federation();
	if (!fed) return null;
	const { url } = event;
	const path = url.pathname;

	if (path.endsWith(FRAGMENT_ROUTES_PATH)) {
		void maybe_deploy_thaw(fed);
		return serve_expose(fed, event);
	}
	if (path.endsWith(HOLE_PATH)) return serve_hole(fed, event);
	if (path.endsWith(THAW_PATH)) return serve_thaw(fed, event);
	// widgets: /og/fragment/<name> (but NOT /og/fragment/page, handled above)
	const frag_at = path.indexOf(FRAGMENT_BASE);
	if (frag_at !== -1) {
		const name = path.slice(frag_at + FRAGMENT_BASE.length);
		if (name && !name.includes('/')) {
			void maybe_deploy_thaw(fed);
			return serve_widget(fed, event, name);
		}
	}
	return null;
}

// ── expose: the whole route table as a fragment document ─────────────────────────────────────
async function serve_expose(fed: Federation, event: RequestEvent): Promise<Response | null> {
	if (!fed.expose) return json_error(404, 'this app exposes no route table (federate({ expose }))');
	const { url, request } = event;
	const t0 = performance.now();
	const trace = child_traceparent(request.headers.get('traceparent'));
	const path = url.searchParams.get('path') ?? '/';
	const search = url.searchParams.get('search') ?? '';
	const target = new URL(
		fed.base + (path.startsWith('/') ? path : '/' + path) + search,
		url.origin
	);

	const body = await read_capped_body(request, fed.max_body);
	if (body === null) return json_error(413, 'body too large');

	// signature gate FIRST (401 before any routing) unless intentionally open
	let claims: Claims | undefined;
	if (!fed.open) {
		const v = verify_signed_request(inbound_verify(fed), request, url, body);
		if (!v) return json_error(401, 'invalid or missing signature');
		claims = v.user;
	}

	const fwd = new Request(target, { method: request.method, headers: request.headers, body });
	fwd.headers.delete(USER_HEADER_NAME); // the raw header never counts as identity
	fwd.headers.set('traceparent', trace.traceparent);
	attach_claims(fwd, claims);

	const capture = begin_source_capture(request);
	const sources = capture.sources;
	let res: Response | null;
	try {
		res = await fed.expose.fetch(fwd, event);
	} finally {
		capture.end();
	}

	const doc = (d: Record<string, unknown>) => {
		const ms = Math.round((performance.now() - t0) * 10) / 10;
		return json_response(
			{
				...d,
				sources: [...sources],
				build: version,
				trace: { trace_id: trace.trace_id, span_id: trace.span_id },
				server_ms: ms
			},
			200,
			{ 'server-timing': `og-fragment;dur=${ms}` }
		);
	};

	if (!res) return doc({ status: 404, title: 'not found', css: [], body: 'router did not match' });
	if (res.status >= 300 && res.status < 400)
		return doc({
			status: res.status,
			location: res.headers.get('location') ?? '/',
			title: '',
			css: [],
			body: ''
		});
	const html = await res.text();
	return doc({ status: res.status, path: fed.base + path, ...lift_document(html, url.origin) });
}

// ── widgets: /og/fragment/<name> ─────────────────────────────────────────────────────────────
async function serve_widget(fed: Federation, event: RequestEvent, name: string): Promise<Response> {
	const { url, request } = event;
	// the manifest is deliberately UNSIGNED — inventory, not data (CI diffs it)
	if (name === '__catalog') {
		const names = [...fed.widgets.keys()].sort();
		const widgets = Object.fromEntries(
			names.map((n) => [n, { props: [...(fed.widgets.get(n)!.props ?? [])].sort() }])
		);
		return json_response({ names, widgets });
	}
	let user: Claims | undefined;
	if (!fed.open) {
		const v = verify_signed_request(inbound_verify(fed), request, url);
		if (!v) return json_error(401, 'invalid or missing signature');
		user = v.user;
	}
	const def = fed.widgets.get(name);
	if (!def) return json_error(404, `unknown fragment '${name}'`);
	const trace = child_traceparent(request.headers.get('traceparent'));
	const t0 = performance.now();
	const props: Record<string, string> = {};
	for (const [k, v] of url.searchParams) props[k] = v;

	const capture = begin_source_capture(request);
	const sources = capture.sources;
	let baked: { html: string | null };
	try {
		baked = await def.make(props, { user, request, url });
	} finally {
		capture.end();
	}
	if (baked?.html == null) return json_error(500, 'fragment did not bake');
	const ms = Math.round((performance.now() - t0) * 10) / 10;
	return json_response(
		{
			html: absolutize(baked.html, url.origin),
			origin: url.origin,
			sources: [...sources],
			build: version,
			trace: { trace_id: trace.trace_id, span_id: trace.span_id },
			server_ms: ms
		},
		200,
		{ 'server-timing': `og-fragment;dur=${ms}` }
	);
}

// ── deferred holes: /og/frag (the shell's own signed capability) ──────────────────────────────
async function serve_hole(fed: Federation, event: RequestEvent): Promise<Response> {
	const { url } = event;
	const p = url.searchParams;
	const peer_name = p.get('peer') ?? '';
	const kind = p.get('kind') ?? '';
	const target = p.get('target') ?? '';
	const search = p.get('search') ?? '';
	const exp = Number(p.get('exp') ?? '0');
	const sig = p.get('sig') ?? '';
	if (!Number.isFinite(exp) || exp < Date.now()) return new Response('gone', { status: 410 });
	if (!fed_app()?.verify(hole_message(peer_name, kind, target, search, exp), sig))
		return new Response('forbidden', { status: 403 });
	const peer = fed.peers.get(peer_name);
	if (!peer) return new Response('unknown peer', { status: 404 });

	// claims are derived HERE, server-side, from the shell's own session — never from the browser
	const claims = fed.visitor?.({
		request: event.request,
		url,
		cookies: event.cookies,
		locals: event.locals
	});
	const traceparent = child_traceparent(event.request.headers.get('traceparent')).traceparent;
	try {
		if (kind === 'widget') {
			const props: Record<string, string> = {};
			for (const [k, v] of new URLSearchParams(search)) props[k] = v;
			const wdoc = await peer.widgetDoc(target, props, { claims, traceparent });
			return hole_html(wdoc.html);
		}
		const doc = await peer.doc(target, search, claims, traceparent);
		if (doc.location)
			return hole_html(
				`<p data-og-moved>This section moved. <a href="${doc.location}">Continue</a></p>`
			);
		return hole_html((doc.css?.join('') ?? '') + (doc.head ?? '') + doc.body);
	} catch {
		return hole_html('', 200);
	}
}

/** A hole response: the runtime swaps this HTML into the region element and its islands wake. */
function hole_html(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
	});
}

// ── thaw: /og/thaw (a peer's publish/deploy notice) ──────────────────────────────────────────
const seen_notices = new Map<string, number>();
const NOTICE_TTL_MS = 10 * 60_000;

async function serve_thaw(fed: Federation, event: RequestEvent): Promise<Response> {
	const { request, url } = event;
	const body = await read_capped_body(request, fed.max_body);
	if (body === null) return json_error(413, 'body too large');

	// identify the SENDER by which peer's key verifies (its name prefixes the thawed tags)
	let sender: (Peer & { keys: readonly string[] }) | null = null;
	let sender_name = '';
	for (const [pname, peer] of fed.peers) {
		if (peer.keys.length === 0) continue;
		const v = verify_signed_request(
			{ publicKeys: peer.keys, audience: fed.audience, skewMs: fed.skew_ms },
			request,
			url,
			body
		);
		if (v) {
			sender = peer;
			sender_name = pname;
			break;
		}
	}
	if (!sender) return json_error(401, 'invalid or missing signature');

	let notice: { id?: string; hop?: number; tags?: string[] | 'all' };
	try {
		notice = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
	} catch {
		return json_error(400, 'bad notice');
	}
	const id = notice.id ?? '';
	// dedupe (sweep expired first)
	const now = Date.now();
	for (const [k, exp] of seen_notices) if (exp <= now) seen_notices.delete(k);
	if (id && seen_notices.has(id)) return json_response({ ok: true, deduped: true });
	if (id) seen_notices.set(id, now + NOTICE_TTL_MS);

	// map the sender's tags into THIS app's namespace (how its peer handle filed the pages)
	const local = map_thaw_tags(sender_name, notice.tags ?? []);
	if (local.length) {
		await fed_app()?.notify.invalidate(local); // this app's own stored pages
		sender.drop(new Set(local)); // this app's cached documents from that peer
	} else if (notice.tags === 'all') {
		await fed_app()?.notify.invalidate([`a:${sender_name}`]);
		sender.drop('all');
	}

	// chain: tell MY consumers, with the tags I just applied, hop+1
	const forward = notice.tags === 'all' ? 'all' : local;
	void broadcast_thaw(fed, {
		id: id || crypto.randomUUID(),
		hop: (notice.hop ?? 0) + 1,
		tags: forward
	});
	return json_response({ ok: true, thawed: local.length });
}

/** `p:<path>` → `p:<peer>:<path>`; `s:…`/`r:…` → `r:<peer>:…`; `a:…` → `a:<peer>`. */
function map_thaw_tags(peer: string, tags: string[] | 'all'): string[] {
	if (tags === 'all') return [];
	return tags.map((t) => {
		if (t.startsWith('p:')) return `p:${peer}:${t.slice(2)}`;
		if (t.startsWith('a:')) return `a:${peer}`;
		return `r:${peer}:${t}`;
	});
}

export type { Federation };
