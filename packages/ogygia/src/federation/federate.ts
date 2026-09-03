/**
 * `federate()` — ONE identity per app. Builds the typed peer handles, registers the app's
 * federation (peers, exposed table, widgets) for the handle to serve, and wires cross-app thaw:
 * every `freeze.invalidate()` notifies the peers that baked this app's fragments. Design:
 * internal/notes/federation.md.
 *
 * Called at server module-eval (in or under hooks.server.ts). The handle reads the registration
 * back to serve `/og/fragment/*`, `/og/thaw`, and the deferred remote-region holes.
 */
import { set_source_observer } from '../freeze/capture.js';
import { set_thaw_notifier } from '../freeze/registry.js';
import { make_peer } from './peer.js';
import { set_federation, current_federation } from './registry.js';
import {
	sign_headers,
	THAW_PATH,
	type Claims,
	type FragmentDocument,
	type WidgetDocument
} from './wire.js';
import type { FederateConfig, Federation, Peer, PeerConfig, Widget, WidgetDef } from './types.js';

const HOP_MAX = 4;

/** A live source observer bound to the CURRENT expose render — the handle sets it per request so a
 *  fragment reports the receipts (`og.source`) its render consumed. Rides a module-local ref set/
 *  cleared around each render (the handle serializes exposes; this is not shared across a stream). */
let active_sources: Set<string> | null = null;
export function begin_source_capture(): Set<string> {
	active_sources = new Set();
	return active_sources;
}
export function end_source_capture(): void {
	active_sources = null;
}

let observer_installed = false;
function ensure_source_observer(): void {
	if (observer_installed) return;
	observer_installed = true;
	set_source_observer((tag) => active_sources?.add(tag));
}

/**
 * `federate({ name, key, peers, visitor, expose?, widgets? })`. Returns the peer handles keyed by
 * their config names: `const { cms, dash } = federate({ … })`.
 */
export function federate<P extends Record<string, PeerConfig>>(
	config: FederateConfig<P>
): { [K in keyof P]: Peer } {
	// FAIL-CLOSED: exposing a table or widgets with NO peer keys configured (and no `open`) means
	// nobody is allowed to call — a config bug, not a choice. Say it loudly.
	const has_inbound = Object.values(config.peers ?? {}).some((p) => p.key);
	if ((config.expose || config.widgets) && !has_inbound && !config.open) {
		console.warn(
			'[ogygia] federate() exposes a table/widgets but no peer has a `key` — every inbound call ' +
				'would be UNAUTHENTICATED. Add each caller as a peer with its public `key`, or pass ' +
				'`open: true` to acknowledge an intentionally open endpoint (behind mTLS / a mesh).'
		);
	}

	const peers = new Map<string, Peer & { keys: readonly string[] }>();
	const out = {} as { [K in keyof P]: Peer };
	for (const [peer_name, peer_cfg] of Object.entries(config.peers ?? {}) as [
		keyof P & string,
		PeerConfig
	][]) {
		const handle = make_peer(peer_name, peer_cfg, config.name, config.key);
		const keys = peer_cfg.key ? ([] as string[]).concat(peer_cfg.key) : [];
		peers.set(peer_name, Object.assign(handle, { keys }));
		out[peer_name] = handle;
	}

	const widgets = new Map<string, { make: Widget; props?: readonly string[] }>();
	for (const [w_name, def] of Object.entries(config.widgets ?? {})) {
		const d = def as WidgetDef;
		widgets.set(w_name, typeof d === 'function' ? { make: d } : { make: d.make, props: d.props });
	}

	const fed: Federation = {
		name: config.name,
		key: config.key,
		peers,
		visitor: config.visitor,
		expose: config.expose,
		base: config.base ?? '',
		widgets,
		audience: config.audience,
		skew_ms: config.skewMs ?? 120_000,
		open: config.open === true,
		max_body: config.maxBodyBytes ?? 1024 * 1024,
		deploy: config.deploy ?? 'auto'
	};
	set_federation(fed);
	ensure_source_observer();

	// THAW: every freeze.invalidate() on THIS app tells the peers that baked its fragments. A peer
	// is notified whether or not it has a key (a pure consumer still needs to drop its SWR copies);
	// signing only happens when this app has a private key.
	set_thaw_notifier(async (tags) => {
		await broadcast_thaw(fed, { id: crypto.randomUUID(), hop: 0, tags });
	});

	return out;
}

/** Send one thaw notice to every peer (fire-and-forget with bounded retries). Also the chain
 *  forwarder: a notice this app RECEIVED and applied re-broadcasts with `hop + 1`. */
export async function broadcast_thaw(
	fed: Federation,
	notice: { id: string; hop: number; tags: string[] | 'all' }
): Promise<void> {
	if (notice.hop >= HOP_MAX) return;
	const bytes = new TextEncoder().encode(JSON.stringify({ ...notice, from: fed.name }));
	const body = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
	await Promise.allSettled([...fed.peers.values()].map((peer) => post_thaw(fed, peer, body)));
}

async function post_thaw(fed: Federation, peer: Peer, body: ArrayBuffer): Promise<void> {
	const u = new URL(THAW_PATH, peer.origin);
	const attempts = [0, 200, 1000, 5000];
	for (let i = 0; i < attempts.length; i++) {
		if (attempts[i]) await sleep(attempts[i]);
		try {
			const signed = fed.key ? sign_headers(fed.key, 'POST', u, body, undefined) : {};
			const res = await fetch(u, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...signed },
				body,
				signal: AbortSignal.timeout(5000)
			});
			if (res.ok) return;
		} catch {
			/* unreachable — retry, then the peer's TTL backstop holds */
		}
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// re-exported so the handle (which holds the region secret) can read the registration
export { current_federation };
export type { Federation, Peer, Claims, FragmentDocument, WidgetDocument };
