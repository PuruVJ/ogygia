/**
 * Devtools event schema v1 — the UI-agnostic wire vocabulary the whole Observatory rides on
 * (internal/notes/devtools.md, Rung 0). Every event is JSON-serializable and keyed on the
 * identities the framework already mints — region fingerprints (`data-og-fp`), island entry ids,
 * hub Ref ids — so a region's compile, server render, wire payload, client wake, and nav-reconcile
 * decision CORRELATE by id with zero new identity machinery. That is what turns a log into a story.
 *
 * Laws (from the note):
 *  - **Versioned from day one.** `DEVTOOLS_SCHEMA_VERSION` is stamped on every event; the trace
 *    format is a public artifact eventually, so a consumer can refuse a version it doesn't know.
 *  - **Sizes always, payload bodies lazy.** Events carry byte COUNTS (cheap — a length already in
 *    hand), never the bytes themselves. A sink that wants the body subscribes to the DOM/network.
 *  - **Don't invent events the code can't cheaply produce.** Every name below maps to a real seam
 *    (see the per-domain comments); nothing here needs an extra serialization pass to emit.
 *
 * Naming: internal, so snake_case is the house style — but these strings travel on the wire and name
 * user-facing instruments, so event NAMES use the `domain.thing.verb` dotted form (stable ids), while
 * the TS field names stay terse. Domains mirror the note's Schema-v1 table.
 */

/** Bump only on a breaking shape change; a trace stamps this so a reader can gate on it. */
export const DEVTOOLS_SCHEMA_VERSION = 1;

/** The six event domains (note's Schema-v1 table). */
export type DevtoolsDomain = 'compile' | 'server' | 'wire' | 'runtime' | 'hub' | 'nav';

/** Fields the bus stamps on EVERY event — the caller never sets these. */
export interface DevtoolsEnvelope {
	/** Schema version ({@link DEVTOOLS_SCHEMA_VERSION}) — copied onto every event for trace gating. */
	v: number;
	/** Monotonic per-session sequence number (ordering that survives equal timestamps). */
	seq: number;
	/** Timestamp: `performance.now()` (ms, sub-ms precision) when available, else `Date.now()`. */
	t: number;
	/** Which realm emitted it — a trace merges client + server streams, so it must be labelled. */
	realm: 'client' | 'server';
}

/** What a call site passes to `emit` — the envelope is added by the bus. */
export type DevtoolsEventInput =
	| CompileEventInput
	| ServerEventInput
	| WireEventInput
	| RuntimeEventInput
	| HubEventInput
	| NavEventInput;

/** A fully-stamped event as it sits in the ring buffer / trace / on a sink. */
export type DevtoolsEvent = DevtoolsEventInput & DevtoolsEnvelope;

// ── compile domain ─────────────────────────────────────────────────────────
// Seam: compiler/region/{transform,emit,identity}.ts — island discovery + chunk emit.
export type CompileEventInput =
	| {
			domain: 'compile';
			name: 'compile.island.discovered';
			/** Region identity (the transform's stable id / iid). */
			iid: string;
			/** Client entry chunk specifier (`entry="…"`). */
			entry?: string;
			/** The two-dial strategy key (`render`+`wake`), e.g. `island:load`, `defer:visible`, `lake`. */
			strategy: string;
			/** csr decision at discovery: does this host ship the ogygia runtime at all. */
			csr: boolean;
	  }
	| {
			domain: 'compile';
			name: 'compile.chunk.emitted';
			/** Deduped wrapper/entry chunk filename. */
			entry: string;
			/** Emitted source size (bytes) — a length already in hand at emit. */
			bytes: number;
	  };

// ── server domain ───────────────────────────────────────────────────────────
// Seam: Region.svelte (render), server/region-endpoint.ts (hole), hooks.ts (handle).
export type ServerEventInput =
	| {
			domain: 'server';
			name: 'server.region.rendered';
			/** `data-og-fp` — the exact key the client wake / reconcile correlate on. */
			fp: string;
			/** island | server | lake | held-inline | held-defer | held-live. */
			mode: string;
			entry?: string;
			/** Rendered HTML size (bytes). */
			htmlBytes?: number;
			/** devalue props sidecar size (bytes). */
			propsBytes?: number;
			/** Wall-clock ms for the component's server render, when measured. */
			ms?: number;
	  }
	| {
			domain: 'server';
			name: 'server.capability.minted';
			/** Signed hole id. */
			id: string;
			/** Capability TTL (seconds). */
			ttl?: number;
	  }
	| {
			domain: 'server';
			name: 'server.delta.skip';
			/** A region the client already has live (`x-ogygia-known`) — server SKIPPED re-rendering it. */
			fp: string;
	  }
	| {
			domain: 'server';
			name: 'server.seed.injected';
			/** page | remote — which document side-channel seed the handle wrote. */
			kind: 'page' | 'remote';
			bytes: number;
	  }
	| {
			domain: 'server';
			name: 'server.freeze';
			/** hit | join | stored | skip | invalidate | invalidate-where | self-evict. */
			op: string;
			/** Store key (URL pathname), or the prefix for the bulk op. */
			url?: string;
			/** Named refusal for `skip` — the same string the dev note prints. */
			reason?: string;
			/** Stored html size (bytes) for `stored`. */
			bytes?: number;
	  };

// ── wire domain ──────────────────────────────────────────────────────────────
// Seam: server/region-props.ts, transport.ts, server/stream-regions.ts, router nav headers.
export type WireEventInput =
	| {
			domain: 'wire';
			name: 'wire.props';
			entry?: string;
			/** devalue payload size (bytes). */
			bytes: number;
	  }
	| {
			domain: 'wire';
			name: 'wire.context';
			bytes: number;
	  }
	| {
			domain: 'wire';
			name: 'wire.frame.batch';
			/** Regions in the single-flight parcel. */
			count: number;
			bytes?: number;
	  }
	| {
			domain: 'wire';
			name: 'wire.known.sent';
			/** Fingerprints the client claimed via `x-ogygia-known`. */
			count: number;
			bytes: number;
	  };

// ── runtime domain ────────────────────────────────────────────────────────────
// Seam: runtime/core.ts (element lifecycle), runtime/interaction.ts (replay).
export type RuntimeEventInput =
	| {
			domain: 'runtime';
			name: 'runtime.boot';
			/** Feature installers that ran (router, lakes, live, interaction, …). */
			features: string[];
	  }
	| {
			domain: 'runtime';
			name: 'region.connected';
			entry?: string;
			fp?: string;
			/** wake attribute (load | idle | visible | interaction | media | none). */
			wake?: string;
			/** True for a `render="defer"` hole (HTML fetched, not inline). */
			deferred: boolean;
			/** True when this region rides an awake ancestor (nested — self-run skipped). */
			nested: boolean;
	  }
	| {
			domain: 'runtime';
			name: 'wake.scheduled';
			entry?: string;
			fp?: string;
			/** The schedule armed (load | idle | visible | interaction | media). */
			when: string;
	  }
	| {
			domain: 'runtime';
			name: 'wake.fired';
			entry?: string;
			fp?: string;
			when: string;
	  }
	| {
			domain: 'runtime';
			name: 'region.hydrate.start';
			entry?: string;
			fp?: string;
	  }
	| {
			domain: 'runtime';
			name: 'region.hydrate.done';
			entry?: string;
			fp?: string;
			/** Wall-clock ms from hydrate start to mounted. */
			ms: number;
	  }
	| {
			domain: 'runtime';
			name: 'region.hydrate.failed';
			entry?: string;
			fp?: string;
			message: string;
	  }
	| {
			domain: 'runtime';
			/** Svelte's silent mismatch RECOVERY discarded this region's entire server DOM and
			 *  re-rendered it client-side — something mutated the region between SSR and wake
			 *  (post-SSR transform, A/B tool, DSD injector). See internal/notes/foreign-dom.md. */
			name: 'region.hydrate.recovered';
			entry?: string;
			fp?: string;
	  }
	| {
			domain: 'runtime';
			name: 'region.server.applied';
			entry?: string;
			endpoint?: string;
			/** Fetched hole HTML size (bytes). */
			bytes: number;
			/** True for an SWR/live re-apply (not the first paint). */
			revalidate: boolean;
	  }
	| {
			domain: 'runtime';
			name: 'interaction.replay';
			entry?: string;
			fp?: string;
			/** Queued clicks replayed after the wake. */
			clicks: number;
			/** Form fields whose typed value was restored. */
			fields: number;
	  };

// ── hub domain ─────────────────────────────────────────────────────────────────
// Seam: ref.ts — the identity layer (mint / resolve / dispose / watch).
export type HubEventInput =
	| {
			domain: 'hub';
			name: 'hub.mint';
			/** Kind discriminator (wire | store | snippet | region | fn | …). */
			kind: string;
			/** Minted Ref id. */
			id: string;
			tag?: string;
	  }
	| {
			domain: 'hub';
			name: 'hub.resolve';
			kind: string;
			id: string;
			scope: string;
			/** Registration tag `<module>#<ExportName>` (wire classes) — the hub inspector's name. */
			tag?: string;
			/** True when an existing instance was reunited (memo hit), false on a fresh decode. */
			hit: boolean;
	  }
	| {
			domain: 'hub';
			name: 'hub.dispose';
			/** page | session | ids — which scope (or a selective id sweep) was torn down. */
			scope: string;
			/** Instances disposed. */
			count: number;
	  };

// ── nav domain ───────────────────────────────────────────────────────────────────
// Seam: runtime/router.ts (navigate), runtime/reconcile.ts (per-region decision).
export type NavEventInput =
	| {
			domain: 'nav';
			name: 'nav.start';
			from: string;
			to: string;
			/** link | goto | popstate | enter. */
			type: string;
	  }
	| {
			domain: 'nav';
			name: 'nav.finish';
			to: string;
			/** Wall-clock ms from nav start to swap committed. */
			ms: number;
			/** True on the reconcile (in-place diff) path, false on the full-swap fallback. */
			reconciled: boolean;
			/** True when the swap ran inside a View Transition. */
			vt: boolean;
	  }
	| {
			domain: 'nav';
			name: 'nav.reconcile';
			/** The reconcile key: `k\0<keepName>` (keep marker) / `p\0<sig>` (persist) / `r\0<fp>` (props fp). */
			key: string;
			/** keep | patch | mount | remove — the per-region delta decision. */
			decision: 'keep' | 'patch' | 'mount' | 'remove';
			/** The region's `entry` module URL — lets the nav lab label the decision by component NAME. */
			entry?: string;
			/** The region's wake strategy, for the nav lab row. */
			wake?: string;
	  }
	| {
			domain: 'nav';
			name: 'nav.batch';
			/** Deferred holes single-flighted into one request. */
			count: number;
	  }
	| {
			domain: 'nav';
			name: 'nav.fallback';
			/** Why the reconcile path was skipped (shadow-dom / reconcile-off). */
			reason: string;
	  };
