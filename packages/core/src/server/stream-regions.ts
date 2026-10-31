/**
 * Region parcels for the batch endpoint (single-flight navigation, a page's first-load holes, OOO).
 * Each rendered region call is boxed as a `<template data-ogygia-slot>` parcel keyed by its capability
 * signature; the client frame stream reads them out of order and drops each into the matching region.
 * A done-sentinel ends the batch.
 *
 * The client reads a parcel as TEXT (runtime/frame-nav.ts), never as DOM. A plain parcel ends at the
 * first `</template>`; an answer that itself carries `</template` (a web component's declarative
 * shadow root) is LENGTH-FRAMED instead — `data-og-len` is its UTF-16 length, the unit the client's
 * decoded string counts in — so its content can never close the box or forge a parcel for another
 * slot, and it no longer falls back to a second request.
 *
 * Pure (no I/O, no Kit) so it stays unit-testable.
 */

/** Sentinel slot appended once a batch finishes, so waiting regions know it is complete. */
const STREAM_DONE_SLOT = '__ogygia_done__';

/** Does `html` carry a `</template` (any case) — one that would close a plain parcel early? */
function has_template_close(html: string): boolean {
	for (let i = html.indexOf('</'); i !== -1; i = html.indexOf('</', i + 2)) {
		if (html.length - i < 10) return false;
		if (html.slice(i + 2, i + 10).toLowerCase() === 'template') return true;
	}
	return false;
}

/** Build a parcel `<template data-ogygia-slot="…">…rendered html…</template>` (length-framed when
 *  the html carries a `</template` of its own). */
export function build_parcel(slot: string, html: string): string {
	if (has_template_close(html))
		return `<template data-ogygia-slot="${slot}" data-og-len="${html.length}">${html}</template>`;
	return `<template data-ogygia-slot="${slot}">${html}</template>`;
}

/** The done-sentinel parcel (empty template) the client watches to end the batch. */
export function done_parcel(): string {
	return `<template data-ogygia-slot="${STREAM_DONE_SLOT}"></template>`;
}
