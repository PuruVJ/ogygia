/**
 * The one seam between the always-on {@link ./core.js core} and the optional feature modules.
 *
 * `core` (and `router`) never statically import a feature impl — that would defeat the per-app
 * tree-shaking the generated runtime entry relies on. Instead each feature's `install()` fills its
 * typed slot here, and core reads the slot. Slots that core calls unconditionally (`lakes`,
 * `forms`) carry a no-op default so the feature can be absent; the rest are `null` until
 * a feature provides them and are read with optional chaining.
 *
 * This is the single wiring mechanism — there is no service locator and no per-feature setter.
 */
import type { Component } from 'svelte';
import type { Frame } from '../frame.js';
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

// ── forms ────────────────────────────────────────────────────────────────
export type FormOps = {
	enabled: boolean;
	snapshot(root: ParentNode, pathKey: string): void;
	restore(pathKey: string): void;
};

// ── the rest (nullable — core reads with optional chaining) ────────────────
/** Wake a cold island when interaction lands inside it; returns a disarm fn. */
export type ArmFn = (el: HTMLElement, fire: () => void) => void | (() => void);

/** `preserve_self_owned: false` = hydration repair (exact server sequence); default = live morph. */
export type MorphFn = (
	parent: Element,
	nodes: ArrayLike<Node>,
	options?: { preserve_self_owned?: boolean }
) => void;

export type WireOps = {
	/** THE hub key (`OgygiaRef`) — every transportable kind crosses under it. */
	REF_WIRE_KEY: string;
	/** Hub resolve: ref → live value (kind-dispatched; browser remembers, server never). */
	resolve: (ref: never, remember: boolean) => unknown;
};

export type RemoteSeedOps = {
	seed_query_responses(text: string): void;
	clear_remote_seeds(): void;
	clear_remote_instances(): void;
};

/**
 * The client frame store, filled by the `frames` feature. Core reads it ONLY on the deferred /
 * live / SWR-lake paths (a region with a signed `endpoint`), so a plain load-hydrated app never
 * bundles the store. Null until the feature installs → core's frame calls are optional-chained.
 */
export type FrameOps = {
	subscribe(a: string, cb: (f: Frame) => void): () => void;
	ensure(
		a: string,
		fetcher: (signal: AbortSignal) => Promise<string>,
		opts?: { force?: boolean }
	): Promise<string>;
	abandon(a: string): void;
	/**
	 * SINGLE-FLIGHT NAVIGATION: batch a page's signed deferred endpoints into the store as one streamed response. Lives
	 * on the seam (not a static router import) so an app with `router` but no deferred/live/lake region
	 * — hence no `frames` feature — never bundles the frame store. The router optional-chains this: no
	 * frames feature ⇒ no `render="defer"` holes to batch ⇒ the call never fires anyway.
	 */
	stream(endpoints: string[]): Promise<void>;
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

/**
 * BOOT → LAZY LINKS. The runtime's lazy chunks — the hydrate core, the router's navigation,
 * interaction replay — use a handful of boot helpers and the boot's session state. They reach them
 * HERE, never by importing a boot module: a module the boot and a lazy chunk both import is shared,
 * and Kit's client build (`preserveEntrySignatures: 'strict'`) forbids the runtime chunk from
 * exporting it, so the bundler splits every such module into a file of its own — the runtime's
 * boot arrived as nine. Each link is filled before its lazy chunk can load: `boot` by core's boot
 * (./boot-link.ts), `router_link` and `interaction_link` by the very loader that imports their chunk
 * (the router's `nav()`, interaction's `replay()`), `sync_attributes` by morph's install. Types only
 * below (erased), so this registry imports none of them.
 * `test/runtime-boot-svelte-free.test.ts` pins that no lazy chunk imports a boot module.
 */
export type BootLink = {
	kit_hydrates_page: typeof import('./kit-boot.js').kit_hydrates_page;
	KitBoot: typeof import('./kit-boot.js').KitBoot;
	ABSOLUTE_URL_SCHEME: RegExp;
	invalidate_hint_set: typeof import('./region-endpoint-url.js').invalidate_hint_set;
	is_warmed_module: typeof import('./region-endpoint-url.js').is_warmed_module;
	warm_island_module: typeof import('./region-endpoint-url.js').warm_island_module;
	props_sidecar_of: typeof import('./sidecar.js').props_sidecar_of;
	parse_region_html: typeof import('./parse-html.js').parse_region_html;
	runtime_session: typeof import('./session.js').runtime_session;
	regions_in_shadow: typeof import('./connected.js').regions_in_shadow;
	yield_task: typeof import('./schedule.js').yield_task;
};
export type RouterLink = {
	document_key: typeof import('./router.js').document_key;
	jump_to_hash: typeof import('./router.js').jump_to_hash;
	push_state: typeof import('./router.js').push_state;
	replace_state: typeof import('./router.js').replace_state;
};
export type InteractionLink = {
	resolve_address: typeof import('./interaction.js').resolve_address;
};

export type Slots = {
	lakes: LakeOps;
	forms: FormOps;
	interaction: ArmFn | null;
	morph: MorphFn | null;
	live: Component<Record<string, unknown>> | null;
	wire: WireOps | null;
	remoteSeeds: RemoteSeedOps | null;
	frames: FrameOps | null;
	nav: NavOps | null;
	/**
	 * Cross-island context bridge, filled by the `context` feature. Walks the DOM from an island up
	 * to seed its `getContext` from a `<Provide>` / drop-in-`setContext` marker above it. Null when the
	 * build detected no ogygia context provider — a plain app never bundles the ~4.7 kB bridge, and
	 * core's call optional-chains to `undefined` (exactly "no provider above", the existing empty case).
	 */
	context: ((start: Element | null) => Map<string, unknown> | undefined) | null;
	/** Boot helpers + session for the lazy chunks (see {@link BootLink}). */
	boot: BootLink | null;
	/** The router's history/scroll helpers for its navigation chunk (see {@link RouterLink}). */
	router_link: RouterLink | null;
	/** Interaction's address resolver for its replay chunk (see {@link InteractionLink}). */
	interaction_link: InteractionLink | null;
	/** Morph's attribute sync, for the navigation's body reconcile. */
	sync_attributes: typeof import('./morph.js').sync_attributes | null;
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
	frames: null,
	nav: null,
	context: null,
	boot: null,
	router_link: null,
	interaction_link: null,
	sync_attributes: null
};

/** A link a lazy chunk needs, or a loud error: every link is filled before its chunk can load, so a
 *  missing one means a chunk ran without the boot that owns it (a test that skipped `link_boot()`). */
function linked<T>(link: T | null, name: string): T {
	if (link === null) throw new Error(`[ogygia] runtime chunk used \`slots.${name}\` before the boot linked it`);
	return link;
}
export const boot_link = (): BootLink => linked(slots.boot, 'boot');
export const router_link = (): RouterLink => linked(slots.router_link, 'router_link');
export const interaction_link = (): InteractionLink => linked(slots.interaction_link, 'interaction_link');
export const morph_sync_attributes = (): NonNullable<Slots['sync_attributes']> =>
	linked(slots.sync_attributes, 'sync_attributes');
