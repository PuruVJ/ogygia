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
const MODULEPRELOAD_TAG_G = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>/g;
const LINK_HREF_RE = /\bhref=["']([^"']*)["']/;

export class DocumentTail {
	readonly #hints = new Map<string, string>();
	readonly #props = new Map<string, string>();

	/** Add a region's `<link rel="modulepreload">` block; each href is kept once (first wins). */
	hint(html: string): void {
		for (const m of html.matchAll(MODULEPRELOAD_TAG_G)) {
			const href = LINK_HREF_RE.exec(m[0])?.[1];
			if (href !== undefined && !this.#hints.has(href)) this.#hints.set(href, m[0]);
		}
	}

	/** Add an island's props sidecar under its fingerprint; identical islands share one. */
	props(fp: string, script: string): void {
		if (!this.#props.has(fp)) this.#props.set(fp, script);
	}

	get empty(): boolean {
		return this.#hints.size === 0 && this.#props.size === 0;
	}

	/** Hint count + sidecar count, for tests and devtools. */
	get size(): { hints: number; props: number } {
		return { hints: this.#hints.size, props: this.#props.size };
	}

	/** The tail's HTML: hints, then props. Empty string when nothing was recorded. */
	render(): string {
		let out = '';
		for (const tag of this.#hints.values()) out += tag;
		for (const script of this.#props.values()) out += script;
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
