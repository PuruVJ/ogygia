/**
 * THE DOCUMENT TAIL — everything ogygia appends before `</body>` on a Kit page, in one place.
 *
 * A region rendered in Kit's own page pass has two things that must not sit where the region is:
 *   1. its module-preload hints — in the head they fire while the HTML is still streaming, so on a
 *      slow line every island chunk starts before the parser reaches the hero and the LCP image
 *      then shares the pipe with all of them (priority cannot help: it orders the queue, it does not
 *      stop what is already in flight);
 *   2. its props sidecar — right after the region it is bytes the browser must download before it
 *      reaches the content below (480 KB above the hero on one measured page).
 * Both go here instead, and the handle emits the tail once, after the content and before the page
 * seeds: HINTS first (they fire the moment the parser reaches the tail, before it chews through the
 * props), then PROPS. The runtime waits for the document to parse before it wakes anything, so by
 * the time an island asks for its chunk the hint is in flight and its sidecar is in the DOM
 * (`runtime/sidecar.ts` finds it by `data-og-fp`).
 *
 * A sidecar is registered as a RENDER, not as text: the region hands over its props plan
 * (server/props-wire.ts) and the tail produces the text when the handle renders it — after the
 * whole page rendered, when the request knows whether the page seed ships. That is what lets every
 * island's props serialize relative to the seed, whichever island rendered first.
 *
 * Dedupe lives here too: one hint per href across every island on the page, one sidecar per
 * fingerprint (identical islands share it).
 *
 * The tail exists only for a Kit page render: `hooks.ts` creates one per request and installs the
 * reader; Region.svelte writes to it only when it also knows it renders inside Kit's page pass
 * (its `kit_page_pass` context mark). Every other render root — a hole endpoint, a baked ticket, a
 * streamed late region, a router document, a foreign fragment — gets `null` and keeps hints in its
 * head and sidecars adjacent, so its HTML stays self-contained wherever it is spliced.
 *
 * Universal module: imported by Region.svelte on both legs, so no Node imports here. On the client
 * the reader is never installed and `document_tail()` is `null`.
 */
import type { SeedIndex } from '../seed-refs.js';
import { escape_script_text } from '../escape.js';
import { HOLES_SCRIPT_TYPE } from '../holes-record.js';
import { ISLAND_GRAPH_ATTR, encode_island_graph } from '../island-graph.js';
import { props_sidecar, type WireText } from './props-wire.js';
import type { HoleStat, IslandInteractivity, IslandStat } from './request-stats.js';

/** What the tail needs of a props plan (server/props-wire.ts `PropsWire`, or a test's stand-in). */
export interface SidecarWire {
	wire(seed: SeedIndex | null): WireText;
	readonly json?: boolean;
	readonly canonical?: string;
	readonly refs?: { count: number; keys: readonly string[] };
	culprit?(): string | null;
}

/** The island facts a region hands over with its plan, for the profiler's Islands table. */
/** A short, safe preview of a hole's props for the profiler (`{"forProduct":"P1"}`), so two holes
 *  of one component read apart; empty for no props, truncated past 80 chars. */
export function props_preview(props: unknown, max = 80): string {
	if (!props || typeof props !== 'object') return '';
	try {
		const s = JSON.stringify(props, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
		if (!s || s === '{}' || s === '[]') return '';
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	} catch {
		return '';
	}
}

export interface IslandMeta {
	entry: string;
	/** the component's SSR function name (Svelte names it after the file); '' when unknown */
	name?: string;
	module_url: string;
	wake: string;
	interactivity?: IslandInteractivity | null;
}

/**
 * THE module-preload hint for one island chunk. EVERY hint is `fetchpriority="low"`: a hint's job
 * is discovery (no parse-then-import waterfall), not priority — nothing an island downloads is
 * needed for first paint, the server painted the content — so island code must never outrank the
 * CSS and the LCP image (Region.svelte has the measured story). Regions hand the tail hrefs, not
 * tags: one string per hint, built once here, never parsed back out of markup.
 */
export function modulepreload_tag(href: string): string {
	return '<link rel="modulepreload" href="' + href + '" fetchpriority="low">';
}

/**
 * The runtime bootstrap: its module script, then a `modulepreload` for each of its static imports
 * (the build's handoff — the few chunks the runtime shares with the rest of the app, e.g. Vite's
 * preload helper and the modules Kit's client transport also uses). The browser only discovers a
 * module's imports after downloading and parsing it; hinted here, they download ALONGSIDE the
 * runtime instead of one round trip after it. Normal priority — the runtime cannot run without
 * them. `data-ogygia-runtime-dep` keeps them attached to the script when the handle moves it
 * (head-presence.ts `runtime_first`).
 */
export function runtime_bootstrap_tags(src: string, deps: readonly string[]): string {
	let html = '<script type="module" data-ogygia-runtime src="' + src + '"></script>';
	for (const dep of deps) html += '<link rel="modulepreload" href="' + dep + '" data-ogygia-runtime-dep>';
	return html;
}

/**
 * The island graph (island-graph.ts) as one inert JSON script: entry → the chunks its code needs.
 * The runtime turns an entry's list into modulepreload links when that island wakes. Empty map →
 * no script.
 */
export function island_graph_script(graph: ReadonlyMap<string, readonly string[]>): string {
	if (graph.size === 0) return '';
	return (
		'<script type="application/json" ' +
		ISLAND_GRAPH_ATTR +
		'>' +
		escape_script_text(encode_island_graph(graph)) +
		'</script>'
	);
}

/** The holes record (`hole()`), read by runtime/hole-facts.ts. */
const HOLES_SCRIPT_OPEN = `<script type="${HOLES_SCRIPT_TYPE}" data-ogygia-holes>`;
const HOLES_SCRIPT_CLOSE = '</script>';

/** A sidecar as the tail keeps it: the plan, and the facts the profiler reads after the render. */
interface Sidecar {
	wire: SidecarWire;
	meta: IslandMeta | null;
	count: number;
	hints: string[];
}

/** What the server minted for one deferred hole on a Kit-hydrated document (see `hole()`). */
export type HoleRecord = {
	/** The signed capability URL the hole's `endpoint` attribute carries. */
	endpoint: string;
	/** The adjacent props sidecar HTML of a hydrating hole, or `''` for a static one. */
	sidecar: string;
};

export class DocumentTail {
	readonly #hints = new Set<string>();
	readonly #graph = new Map<string, readonly string[]>();
	readonly #props = new Map<string, Sidecar>();
	readonly #holes = new Map<string, HoleRecord>();
	readonly #hole_notes = new Map<string, HoleStat>();
	/** per-fingerprint facts of the last `render()` (the profiler's Islands table) */
	#island_rows: IslandStat[] | null = null;

	/** Add a region's module-preload hrefs; each href is hinted once (first wins). With `fp`, the
	 *  hrefs are also remembered as that island's JS closure. */
	hints(hrefs: readonly string[], fp?: string): void {
		for (const href of hrefs) this.#hints.add(href);
		if (fp) {
			const s = this.#props.get(fp);
			if (s && s.hints.length === 0) s.hints = [...hrefs];
		}
	}

	/** The list already recorded for an entry, if any — a second instance of an island reuses it. */
	graph_of(entry: string): readonly string[] | undefined {
		return this.#graph.get(entry);
	}

	/** Record the chunks an island entry's code needs (the island graph — data, not hints: the
	 *  runtime preloads them when the island wakes). One list per entry (first wins). With `fp`, the
	 *  list is also remembered as that island's JS closure for the profiler. */
	graph(entry: string, hrefs: readonly string[], fp?: string): void {
		if (!this.#graph.has(entry)) this.#graph.set(entry, hrefs);
		if (fp) {
			const s = this.#props.get(fp);
			if (s && s.hints.length === 0) s.hints = [entry, ...hrefs];
		}
	}

	/** Register an island's props sidecar under its fingerprint; identical islands share one (the
	 *  count still says how many). `meta` is what the profiler's Islands table shows. */
	props(fp: string, wire: SidecarWire, meta: IslandMeta | null = null): void {
		const have = this.#props.get(fp);
		if (have) have.count++;
		else this.#props.set(fp, { wire, meta, count: 1, hints: [] });
	}

	/** Note a deferred hole the page rendered (every document, not only Kit-hydrated ones): its
	 *  schedule and cache policy, for the profiler's hole economics. */
	note_hole(id: string, when: string, hydrate: string | null, ttl: number, name = '', props: unknown = undefined): void {
		const key = `${id}\0${when}\0${hydrate ?? ''}\0${ttl}`;
		const have = this.#hole_notes.get(key);
		if (have) have.count++;
		else this.#hole_notes.set(key, { id, name, props: props_preview(props), when, hydrate, ttl, count: 1 });
	}

	/** The holes noted on this page. */
	hole_rows(): HoleStat[] {
		return [...this.#hole_notes.values()];
	}

	/** The per-island facts of the last `render()` — `null` before it ran. */
	island_rows(): IslandStat[] | null {
		return this.#island_rows;
	}

	/**
	 * Record a deferred hole's server-minted facts under its identity (`data-og-hole`), for a
	 * KIT-HYDRATED document only. Kit can give up hydrating such a document (a component threw, the
	 * markup mismatched): Svelte clears Kit's root and mounts it fresh, and every hole is rendered
	 * again by the client leg — with no address, since only the server can mint one. The tail sits
	 * OUTSIDE Kit's root, so this record survives that rebuild, and the runtime hands each rebuilt
	 * hole its address (and a hydrating hole its props sidecar) back by identity — never by
	 * position. Identical holes (same id + props → same identity) share one record.
	 */
	hole(identity: string, endpoint: string, sidecar: string): void {
		if (identity && endpoint && !this.#holes.has(identity)) this.#holes.set(identity, { endpoint, sidecar });
	}

	get empty(): boolean {
		return (
			this.#hints.size === 0 && this.#graph.size === 0 && this.#props.size === 0 && this.#holes.size === 0
		);
	}

	/** Hint count + graph entry count + sidecar count + hole-record count, for tests and devtools. */
	get size(): { hints: number; graph: number; props: number; holes: number } {
		return { hints: this.#hints.size, graph: this.#graph.size, props: this.#props.size, holes: this.#holes.size };
	}

	/** The tail's HTML: hints, the island graph, then props (each rendered now, against `seed`), then
	 *  the holes record (one script, JSON, `<`-escaped). Empty string when nothing was recorded. With
	 *  `detail`, the per-island rows (bytes, lane, references, the devalue culprit) are kept for
	 *  the profiler — a little extra work, only while it records. */
	render(seed: SeedIndex | null = null, detail = false): string {
		let out = '';
		for (const href of this.#hints) out += modulepreload_tag(href);
		out += island_graph_script(this.#graph);
		const rows: IslandStat[] | null = detail ? [] : null;
		for (const [fp, s] of this.#props) {
			const w = s.wire.wire(seed);
			out += props_sidecar(fp, w, 'tail');
			if (rows) {
				rows.push({
					fp,
					entry: s.meta?.entry ?? '',
					name: s.meta?.name ?? '',
					module_url: s.meta?.module_url ?? '',
					wake: s.meta?.wake ?? '',
					props_bytes: w.text.length,
					canonical_bytes: s.wire.canonical?.length ?? w.text.length,
					json: w.json,
					culprit: w.json ? null : (s.wire.culprit?.() ?? null),
					refs: s.wire.refs?.count ?? 0,
					ref_keys: [...(s.wire.refs?.keys ?? [])],
					hints: s.hints,
					interactivity: s.meta?.interactivity ?? null,
					count: s.count
				});
			}
		}
		this.#island_rows = rows;
		if (this.#holes.size) {
			const record: Record<string, HoleRecord> = {};
			for (const [identity, facts] of this.#holes) record[identity] = facts;
			out += HOLES_SCRIPT_OPEN + escape_script_text(JSON.stringify(record)) + HOLES_SCRIPT_CLOSE;
		}
		return out;
	}
}

type TailReader = () => DocumentTail | null;

let reader: TailReader | null = null;

/** Server (`hooks.ts`) installs a request-scoped reader; `null` uninstalls. */
export function set_tail_reader(fn: TailReader | null): void {
	reader = fn;
}

/** The current request's tail, or `null` when this render has none (client, endpoint, test). */
export function document_tail(): DocumentTail | null {
	return reader ? reader() : null;
}
