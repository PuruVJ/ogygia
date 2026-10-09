/**
 * `mount(peer)` — one route-table entry renders a whole remote app under shell chrome, and
 * `mount.kit(peer)` does it from a plain SvelteKit catchall. The peer comes from `federate()`; all
 * transport policy (signing, timeout, SWR cache, coalescing) lives on it. Ported from the v1
 * `mount()` — the wire behavior (status/redirect/form translation, canary, streaming) is unchanged;
 * it just takes a `Peer` instead of a `client()`.
 */
import { page } from '../router/define.js';
import type { PageDef } from '../router/define.js';
import type { Ctx } from '../router/ctx.js';
import { redirect } from '../router/respond.js';
import { assigned_buckets, type ComponentPick } from '../flags.js';
import { child_traceparent, type Claims, type FragmentDocument } from './wire.js';
import type { Peer } from './types.js';

export interface MountOptions {
	/** OVERRIDE the visitor claims for this mount. Default: the federation's `visitor` as it
	 *  reaches `c.visitor`, plus the table's experiment buckets, auto-carried. */
	user?: (c: Ctx) => Claims | undefined;
	/** STREAM the mount: the shell's page flushes immediately with `fallback` in the slot, and the
	 *  fragment swaps in down the SAME response when the peer answers. GET only. */
	stream?: boolean | { fallback?: string | unknown };
}

/** The on-behalf-of claims for a hop: the table's ONE identity + auto-carried flag decisions. */
function claims_for(c: Ctx, user_override?: (c: Ctx) => Claims | undefined): Claims | undefined {
	const base = user_override ? user_override(c) : (c.visitor as Claims | undefined);
	const buckets = assigned_buckets(c.request);
	if (!buckets || Object.keys(buckets).length === 0) return base;
	return {
		...base,
		experiments: { ...buckets, ...((base?.experiments as object | undefined) ?? {}) }
	};
}

const SKELETON =
	'<div data-og-mount-fallback style="min-height:6rem;border-radius:8px;background:linear-gradient(90deg,#f3f4f6,#e5e7eb,#f3f4f6)"></div>';
const FAILED =
	'<div data-og-mount-failed style="border:1px dashed #dc2626;border-radius:8px;padding:1rem;color:#dc2626">This section is temporarily unavailable.</div>';

/**
 * `'/cms/[...rest]': mount(cms)` where `cms` is a peer from `federate()`. A per-request resolver
 * (`mount(v2.pick({ off, on }))` or `mount((c) => peer)`) is the canary / blue-green form —
 * A/B-of-infrastructure with the same `pick` verb that chooses components.
 */
function mount_fn(
	target: Peer | ComponentPick | ((c: Ctx) => Peer),
	opts: MountOptions = {}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): PageDef<any, any, any, any, any> {
	const fixed =
		typeof target === 'function' ? null : '__ogpick' in target ? null : (target as Peer);
	const resolve_peer = (c: Ctx): Peer => {
		if (fixed) return fixed;
		const got =
			typeof target === 'function' ? target(c) : (target as ComponentPick).__ogpick(c as never);
		if (!got || typeof (got as Peer).doc !== 'function')
			throw new Error(
				`[ogygia] mount(): the ${typeof target === 'function' ? 'resolver' : 'pick'} must yield a peer (from federate({ peers })).`
			);
		return got as Peer;
	};

	if (opts.stream) {
		const fb =
			typeof opts.stream === 'object' && opts.stream.fallback != null
				? opts.stream.fallback
				: SKELETON;
		const stream_slot = async function* (c: Ctx) {
			if (typeof fb === 'string') yield fb;
			else {
				const { region } = await import('../region-core.js');
				yield region(fb as never, {});
			}
			const peer = resolve_peer(c);
			const rest = (c.params as { rest?: string }).rest ?? '';
			try {
				const doc = await peer.doc(
					'/' + rest,
					c.url.search,
					claims_for(c, opts.user),
					child_traceparent(c.request.headers.get('traceparent')).traceparent
				);
				if (doc.location) {
					yield `<p data-og-mount-moved>This page moved. <a href="${doc.location}">Continue</a></p>`;
					return;
				}
				yield (doc.css?.join('') ?? '') + (doc.head ?? '') + doc.body;
			} catch {
				yield FAILED;
			}
		};
		return page(stream_slot as never, {
			actions: { default: mount_action(resolve_peer, opts) }
		});
	}

	const mounted_view = {
		__ogpick: (_c: Ctx, data: Record<string, unknown>) => {
			const doc = data.doc as FragmentDocument;
			return {
				__oghtml: true as const,
				html: doc.body,
				css: doc.css,
				title: doc.title || undefined,
				head: doc.head,
				status: doc.status
			};
		}
	};

	return page(mounted_view, {
		load: async (c) => {
			const peer = resolve_peer(c);
			const rest = (c.params as { rest?: string }).rest ?? '';
			const trace = child_traceparent(c.request.headers.get('traceparent'));
			const t0 = performance.now();
			const doc = await peer.doc(
				'/' + rest,
				c.url.search,
				claims_for(c, opts.user),
				trace.traceparent
			);
			const hop_ms = Math.round((performance.now() - t0) * 10) / 10;
			if (doc.location) redirect(doc.status as 301 | 302 | 303 | 307 | 308, doc.location);
			c.setHeaders?.({
				'server-timing':
					`${peer.label};dur=${hop_ms}` +
					(doc.server_ms != null ? `, ${peer.label}-render;dur=${doc.server_ms}` : ''),
				...(doc.trace ? { 'x-og-trace': doc.trace.trace_id } : {})
			});
			return { doc };
		},
		actions: { default: mount_action(resolve_peer, opts) }
	});
}

function mount_action(resolve_peer: (c: Ctx) => Peer, opts: MountOptions) {
	return async (c: Ctx) => {
		const peer = resolve_peer(c);
		const rest = (c.params as { rest?: string }).rest ?? '';
		const body = await c.request.arrayBuffer();
		const doc = await peer.postDoc(
			'/' + rest,
			c.url.search,
			body,
			c.request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
			claims_for(c, opts.user),
			child_traceparent(c.request.headers.get('traceparent')).traceparent
		);
		if (doc.location) redirect(303, doc.location);
		return { doc };
	};
}

// ── mount.kit: mounting WITHOUT ogygia's router ──────────────────────────────────────────────
type KitMountEvent = {
	params: Partial<Record<string, string>>;
	url: URL;
	request: Request;
	setHeaders?: (headers: Record<string, string>) => void;
};

export interface KitMountOptions {
	/** Visitor claims for each hop — a plain Kit app has no `c.visitor`, so identity is read off
	 *  the EVENT (cookies / locals) explicitly. */
	user?: (e: KitMountEvent) => Claims | undefined;
	/** The catchall param name (`src/routes/cms/[...rest]` → 'rest'). Default 'rest'. */
	param?: string;
}

/** Mount a peer from a plain SvelteKit catchall — `export const load = mount.kit(cms).load`. */
export function kit_mount(
	peer: Peer,
	opts: KitMountOptions = {}
): {
	load: (e: KitMountEvent) => Promise<{ doc: FragmentDocument }>;
	actions: { default: (e: KitMountEvent) => Promise<{ doc: FragmentDocument }> };
} {
	const param = opts.param ?? 'rest';
	const kit = () => import('@sveltejs/kit');
	return {
		load: async (e) => {
			const rest = e.params[param] ?? '';
			const trace = child_traceparent(e.request.headers.get('traceparent'));
			const t0 = performance.now();
			const doc = await peer.doc('/' + rest, e.url.search, opts.user?.(e), trace.traceparent);
			const hop_ms = Math.round((performance.now() - t0) * 10) / 10;
			const { error: kit_error, redirect: kit_redirect } = await kit();
			if (doc.location) kit_redirect(doc.status as 301, doc.location);
			e.setHeaders?.({
				'server-timing':
					`${peer.label};dur=${hop_ms}` +
					(doc.server_ms != null ? `, ${peer.label}-render;dur=${doc.server_ms}` : ''),
				...(doc.trace ? { 'x-og-trace': doc.trace.trace_id } : {})
			});
			if (doc.status >= 400) kit_error(doc.status, doc.title || 'This section is unavailable.');
			return { doc };
		},
		actions: {
			default: async (e) => {
				const rest = e.params[param] ?? '';
				const body = await e.request.arrayBuffer();
				const doc = await peer.postDoc(
					'/' + rest,
					e.url.search,
					body,
					e.request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
					opts.user?.(e),
					child_traceparent(e.request.headers.get('traceparent')).traceparent
				);
				const { redirect: kit_redirect } = await kit();
				if (doc.location) kit_redirect(303, doc.location);
				return { doc };
			}
		}
	};
}

/** `mount(peer)` in a table, or `mount.kit(peer)` from a Kit catchall. */
export const mount = Object.assign(mount_fn, { kit: kit_mount });
