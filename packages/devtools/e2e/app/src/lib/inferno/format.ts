// Formatting helpers, each written the way it usually is the first time. The comment on each says
// which slow pattern the profiler should name (or, for a DECOY, why it should stay quiet).

/** PATTERN formatter-per-call: a new NumberFormat for every price on the page */
export function formatMoney(n: number, currency: string, locale = 'en-US'): string {
	return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
}

/** PATTERN formatter-per-call (the build and the use on two lines: V8 charges the use) */
export function relTime(iso: string, locale = 'en-US'): string {
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	return rtf.format(Math.round((Date.parse(iso) - Date.UTC(2026, 0, 1)) / 86_400_000), 'day');
}

/** PATTERN formatter-per-call: localeCompare with options builds a collator on every compare */
export function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
}

/** PATTERN date-parse: every review date parsed from text, for every card, on every render */
export function newestReview(reviews: { at: string }[]): number {
	let best = 0;
	for (const r of reviews) best = Math.max(best, new Date(r.at).getTime());
	return best;
}

/** DECOY: a formatter built ONCE at module scope and used per row — the right way */
const PCT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
export const pct = (x: number) => PCT.format(x);

/** DECOY: a Date from a number is not parsing text */
export const dayOf = (ms: number) => new Date(ms - (ms % 86_400_000)).getUTCDay();
