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

const MODULEPRELOAD_TAG_G = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>/g;
const LINK_HREF_RE = /\bhref=["']([^"']*)["']/;
/** The holes record (`hole()`), read by runtime/hole-facts.ts. */
const HOLES_SCRIPT_OPEN = `<script type="${HOLES_SCRIPT_TYPE}" data-ogygia-holes>`;
const HOLES_SCRIPT_CLOSE = '</script>';

/** Produces one sidecar's `<script>` given the page seed's index when the seed ships (`null` when
 *  it does not). */
export type SidecarRender = (seed: SeedIndex | null) => string;

/** What the server minted for one deferred hole on a Kit-hydrated document (see `hole()`). */
export type HoleRecord = {
	/** The signed capability URL the hole's `endpoint` attribute carries. */
	endpoint: string;
	/** The adjacent props sidecar HTML of a hydrating hole, or `''` for a static one. */
	sidecar: string;
};

export class DocumentTail {
	readonly #hints = new Map<string, string>();
	readonly #props = new Map<string, SidecarRender>();
	readonly #holes = new Map<string, HoleRecord>();

	/** Add a region's `<link rel="modulepreload">` block; each href is kept once (first wins). */
	hint(html: string): void {
		for (const m of html.matchAll(MODULEPRELOAD_TAG_G)) {
			const href = LINK_HREF_RE.exec(m[0])?.[1];
			if (href !== undefined && !this.#hints.has(href)) this.#hints.set(href, m[0]);
		}
	}

	/** Register an island's props sidecar under its fingerprint; identical islands share one. */
	props(fp: string, render: SidecarRender): void {
		if (!this.#props.has(fp)) this.#props.set(fp, render);
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
		return this.#hints.size === 0 && this.#props.size === 0 && this.#holes.size === 0;
	}

	/** Hint count + sidecar count + hole-record count, for tests and devtools. */
	get size(): { hints: number; props: number; holes: number } {
		return { hints: this.#hints.size, props: this.#props.size, holes: this.#holes.size };
	}

	/** The tail's HTML: hints, then props (each rendered now, against `seed`), then the holes
	 *  record (one script, JSON, `<`-escaped). Empty string when nothing was recorded. */
	render(seed: SeedIndex | null = null): string {
		let out = '';
		for (const tag of this.#hints.values()) out += tag;
		for (const render of this.#props.values()) out += render(seed);
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
