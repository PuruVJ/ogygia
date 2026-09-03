/**
 * federation v2 — shared contracts. Design: internal/notes/federation.md.
 *
 * ONE identity per app (`federate()`), a SYMMETRIC peers map (public keys verify inbound, the
 * app's private key signs outbound), remote fragments as REGION VALUES with the region dials, and
 * cross-app THAW notices so a publish or a deploy on one team thaws the frozen pages of every
 * team that baked its fragments.
 */
import type { RegionValue } from '../region.js';
import type { Router } from '../router/router.js';
import type { Claims } from './wire.js';

/** Visitor claims resolver — `federate({ visitor })`. Reads the LIVE event (cookies, locals);
 *  runs on the shell for every hop, including hole-time fetches of deferred remote regions. */
export type VisitorResolver = (event: {
	request: Request;
	url: URL;
	cookies?: { get(name: string): string | undefined };
	locals?: unknown;
}) => Claims | undefined;

/** One peer — an app this app talks to, in either direction. */
export interface PeerConfig {
	/** Origin(s). Extra entries are same-build REPLICAS tried in order for READS (a retried
	 *  mutation risks a double write — POSTs stay on the first). */
	origin: string | string[];
	/** The peer's Ed25519 PUBLIC key(s), base64 SPKI DER — verifies calls and thaw notices FROM
	 *  it. A list = rotation overlap. Omit for a peer this app only CALLS (never hears from). */
	key?: string | string[];
	/** Max ms per UNCACHED hop; a miss becomes a boundary card, never a hung shell. Default 5000. */
	timeout?: number;
	/** Stale-while-revalidate cache for this peer's documents (ms). Entries carry the fragment's
	 *  source tags, so a thaw notice drops exactly the stale ones. Off when omitted. */
	cache?: { ttl: number; max?: number };
	/** The audience signed into hops TO this peer (must equal what it verifies as its own).
	 *  Defaults to the origin's host — set both ends only when a proxy rewrites Host. */
	audience?: string;
	/** Server-Timing label (default: the peer's name). */
	label?: string;
}

/** What a catalog widget receives alongside the caller-chosen props. */
export interface WidgetInfo {
	/** Signature-bound visitor claims (undefined when anonymous). AUTHORIZE against THESE —
	 *  props are caller-chosen, claims are not. */
	user?: Claims;
	request: Request;
	url: URL;
}

/** A widget: props in, an awaitable `{ html }` out — `region(Comp, props)` IS that shape. */
export type Widget = (
	props: Record<string, string>,
	info: WidgetInfo
) => PromiseLike<{ html: string | null }> | { html: string | null };

export type WidgetDef = Widget | { props: readonly string[]; make: Widget };

export interface FederateConfig<P extends Record<string, PeerConfig> = Record<string, PeerConfig>> {
	/** This app's name — the tag prefix peers file its fragments under (`r:<name>:…`). */
	name: string;
	/** This app's Ed25519 PRIVATE key (base64 PKCS8 DER; `npx ogygia keys <name>`). Signs every
	 *  outbound hop and thaw notice. Omit for an app that only ANSWERS (never calls). */
	key?: string;
	/** Everyone this app talks to, in either direction. */
	peers?: P;
	/** THE visitor identity for outbound hops (on-behalf-of, signed, never via the browser). */
	visitor?: VisitorResolver;
	/** Serve this route table as fragments at `/og/fragment/page` (the MFE side). */
	expose?: Router;
	/** The mount base the exposed table renders under (`routes(table, { base })`). */
	base?: string;
	/** Named widget catalog served at `/og/fragment/<name>`; `__catalog` = the unsigned manifest. */
	widgets?: Record<string, WidgetDef>;
	/** The audience(s) THIS app verifies inbound calls against. Defaults to the request host;
	 *  set when a reverse proxy rewrites Host between the hops. */
	audience?: string | string[];
	/** Clock skew / replay window for inbound signatures (ms, default 120 000). */
	skewMs?: number;
	/** Acknowledge an intentionally OPEN endpoint (mTLS / mesh): serve `expose`/`widgets` with no
	 *  peer keys configured. Without it, exposing with nobody allowed to call is a config error. */
	open?: boolean;
	/** Cap on a forwarded fragment body (bytes, default 1 MiB). */
	maxBodyBytes?: number;
	/** Deploy detection: `'auto'` (default) broadcasts a thaw-all to peers on boot with a new
	 *  build id; `'manual'` leaves it to `freeze.invalidateApp()`. */
	deploy?: 'auto' | 'manual';
}

/** The dials a remote region takes — the region dials, with the same meanings. */
export interface RemoteDials {
	/** `'static'` (default): one buffered signed hop during THIS render, HTML baked. `'deferred'`:
	 *  a hole — the browser fetches it from the SHELL's handle (signed capability), which forwards
	 *  to the peer with the visitor's claims derived at hole time. */
	render?: 'static' | 'deferred';
	/** Override the visitor claims for this hop (default: the federation's `visitor`, plus every
	 *  experiment bucket the request decided). */
	claims?: Claims;
}

/** A peer handle — what `federate()` returns per peer. */
export interface Peer {
	readonly name: string;
	readonly origin: string;
	readonly label: string;
	/** A remote ROUTE of this peer's exposed table as a region value. Static: awaits the hop and
	 *  bakes; deferred: a signed hole. */
	page(path: string, dials?: RemoteDials & { search?: string }): Promise<RegionValue>;
	/** A named widget of this peer's catalog as a region value. */
	widget(name: string, props?: Record<string, string>, dials?: RemoteDials): Promise<RegionValue>;
	/** Transport (used by `mount()`): the page DOCUMENT for a path (cache/SWR/coalescing). */
	doc(
		path: string,
		search: string,
		claims?: Claims,
		traceparent?: string
	): Promise<import('./wire.js').FragmentDocument>;
	/** Transport: a mutation document — bypasses and invalidates the cache. */
	postDoc(
		path: string,
		search: string,
		body: ArrayBuffer,
		content_type: string,
		claims?: Claims,
		traceparent?: string
	): Promise<import('./wire.js').FragmentDocument>;
	/** Transport: a raw widget document. */
	widgetDoc(
		name: string,
		props?: Record<string, string>,
		opts?: { claims?: Claims; traceparent?: string }
	): Promise<import('./wire.js').WidgetDocument>;
	/** Thaw: drop cached documents carrying any of these tags (`'all'` = every entry). */
	drop(tags: ReadonlySet<string> | 'all'): void;
}

/** The registered federation — what `federate()` builds and the handle reads back. */
export interface Federation {
	readonly name: string;
	readonly key: string | undefined;
	readonly peers: ReadonlyMap<string, Peer & { readonly keys: readonly string[] }>;
	readonly visitor: VisitorResolver | undefined;
	readonly expose: Router | undefined;
	readonly base: string;
	readonly widgets: ReadonlyMap<string, { make: Widget; props?: readonly string[] }>;
	readonly audience: string | string[] | undefined;
	readonly skew_ms: number;
	readonly open: boolean;
	readonly max_body: number;
	readonly deploy: 'auto' | 'manual';
}
