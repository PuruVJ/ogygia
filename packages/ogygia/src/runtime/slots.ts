/**
 * The one seam between the always-on {@link ./core.js core} and the optional feature modules.
 *
 * `core` (and `router`) never statically import a feature impl — that would defeat the per-app
 * tree-shaking the generated runtime entry relies on. Instead each feature's `install()` fills its
 * typed slot here, and core reads the slot. Slots that core calls unconditionally (`lakes`,
 * `persist`, `forms`) carry a no-op default so the feature can be absent; the rest are `null` until
 * a feature provides them and are read with optional chaining.
 *
 * This is the single wiring mechanism — there is no service locator and no per-feature setter.
 */
import type { Component } from 'svelte';
import type { PersistPair } from './persist.js';
import { is_frozen } from './region-attrs.js';

// ── lakes ────────────────────────────────────────────────────────────────
/** Frozen SSR DOM detached before hydrate. */
export type LiftedLake = {
	id: string;
	frag: DocumentFragment;
	endpoint: string;
	when: string;
	maxAgeMs: number;
};

/** Region schedule hooks lakes need without importing the custom element. */
export type LakeArm = {
	idle: (fire: () => void) => void;
	visible: (fire: () => void, margin?: string) => void;
	media: (when: string, fire: () => void) => void;
	fetch_revalidate: () => void;
	wake_children: () => void;
};

export type LakeOps = {
	on_frozen_connect(el: HTMLElement, arm: LakeArm): boolean;
	wait_for_boundary(el: HTMLElement, boundary: Element | null): boolean;
	lift(parent: Element): LiftedLake[];
	restore(parent: Element, lifted: LiftedLake[]): void;
	settle_in(root: ParentNode): void;
	mark_frozen_settled(region: HTMLElement): void;
	after_html_swap(region: HTMLElement, opts: { revalidate?: boolean }): void;
	after_fetch_exhausted(
		region: HTMLElement,
		opts: { revalidate?: boolean },
		wake_children: () => void
	): void;
};

// ── persist ──────────────────────────────────────────────────────────────
export type PersistOps = {
	/** Read by core (`disconnectedCallback`): keep a relocating persist island mounted. */
	is_persist_preserving(el: Element): boolean;
	/** Read by the router around a body swap. */
	collect(from: ParentNode, to: ParentNode): PersistPair[];
	relocate(pairs: PersistPair[]): void;
	end(pairs: PersistPair[]): void;
};

// ── forms ────────────────────────────────────────────────────────────────
export type FormOps = {
	enabled: boolean;
	snapshot(root: ParentNode, pathKey: string): void;
	restore(pathKey: string): void;
};

// ── the rest (nullable — core reads with optional chaining) ────────────────
/** Wake a cold island when interaction lands inside it; returns a disarm fn. */
export type ArmFn = (el: HTMLElement, fire: () => void) => void | (() => void);

export type MorphFn = (parent: Element, nodes: Node[]) => void;

export type WireOps = {
	TRANSPORT_WIRE_KEY: string;
	revive_transportable: (payload: never, remember: boolean) => unknown;
};

export type RemoteSeedOps = {
	seed_query_responses(text: string): void;
	clear_remote_seeds(): void;
	clear_remote_instances(): void;
};

export type SpeculateOps = { reinstall(): void };

/**
 * Per-document lifecycle, filled by {@link ./core.js core} in `boot()` (not by a feature). The
 * router reads it around a body swap so router modules never import core's Svelte component graph.
 */
export type SpaLifecycle = {
	prepare(): void;
	finish(): void;
	softInvalidate(doc: Document): void;
};

// ── nav ──────────────────────────────────────────────────────────────────
/**
 * SPA navigation, filled by the router feature. Read by the kit-remote client stub (used by the
 * always-on remote-seeds feature) so a remote COMMAND can navigate/invalidate WITHOUT the stub
 * statically importing `router.js` (~10 KB). Null when no router loaded → callers full-page fallback.
 */
export type NavOps = {
	goto(url: string | URL, opts?: unknown): Promise<void>;
	invalidateAll(): Promise<void>;
};

export type Slots = {
	lakes: LakeOps;
	persist: PersistOps;
	forms: FormOps;
	interaction: ArmFn | null;
	morph: MorphFn | null;
	live: Component<Record<string, unknown>> | null;
	wire: WireOps | null;
	remoteSeeds: RemoteSeedOps | null;
	speculate: SpeculateOps | null;
	spaLifecycle: SpaLifecycle | null;
	nav: NavOps | null;
};

/** The live registry. A feature's `install()` assigns its slot; core/router read them. */
export const slots: Slots = {
	lakes: {
		on_frozen_connect: (el) => is_frozen(el),
		wait_for_boundary: () => false,
		lift: () => [],
		restore: () => {},
		settle_in: () => {},
		mark_frozen_settled: () => {},
		after_html_swap: () => {},
		after_fetch_exhausted: () => {}
	},
	persist: {
		is_persist_preserving: () => false,
		collect: () => [],
		relocate: () => {},
		end: () => {}
	},
	forms: {
		enabled: false,
		snapshot: () => {},
		restore: () => {}
	},
	interaction: null,
	morph: null,
	live: null,
	wire: null,
	remoteSeeds: null,
	speculate: null,
	spaLifecycle: null,
	nav: null
};
