/**
 * Region parcels for the batch endpoint (route weaving / navigation OOO). Each rendered region call
 * is boxed as a `<template data-ogygia-slot>` parcel keyed by its capability signature; the client
 * frame stream reads them out of order and drops each into the matching region. A done-sentinel ends
 * the batch. `<template>` content is inert (no paint, no scripts, no image loads), so a parcel is
 * safe to append anywhere.
 *
 * Pure (no I/O, no Kit) so it stays unit-testable.
 */

/** Sentinel slot appended once a batch finishes, so waiting regions know it is complete. */
const STREAM_DONE_SLOT = '__ogygia_done__';

/** A literal `</template` that would break out of a parcel box. */
const TEMPLATE_CLOSE = /<\/template/i;

/**
 * Build a parcel `<template data-ogygia-slot="…">…rendered html…</template>`.
 * Returns null when the HTML contains a literal `</template` (which would break out of the box) — that
 * region then simply falls back to the client fetch, so a batch never corrupts the page.
 */
export function build_parcel(slot: string, html: string): string | null {
	if (TEMPLATE_CLOSE.test(html)) return null;
	return `<template data-ogygia-slot="${slot}">${html}</template>`;
}

/** The done-sentinel parcel (empty template) the client watches to end the batch. */
export function done_parcel(): string {
	return `<template data-ogygia-slot="${STREAM_DONE_SLOT}"></template>`;
}
