// /inferno's formatting helpers with the profiler's fix applied: every formatter built once.
// (No PATTERN comments here: this copy exists to measure the forecast, not to be found.)

const money = new Map<string, Intl.NumberFormat>();
export function formatMoney(n: number, currency: string, locale = 'en-US'): string {
	const key = `${locale}|${currency}`;
	let f = money.get(key);
	if (!f) money.set(key, (f = new Intl.NumberFormat(locale, { style: 'currency', currency })));
	return f.format(n);
}

const rel = new Map<string, Intl.RelativeTimeFormat>();
export function relTime(iso: string, locale = 'en-US'): string {
	let rtf = rel.get(locale);
	if (!rtf) rel.set(locale, (rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })));
	return rtf.format(Math.round((Date.parse(iso) - Date.UTC(2026, 0, 1)) / 86_400_000), 'day');
}

const COLLATOR = new Intl.Collator('de', { sensitivity: 'base' });
export function byName(a: { name: string }, b: { name: string }): number {
	return COLLATOR.compare(a.name, b.name);
}

// (not a counted fix: the cards still parse their review dates)
export function newestReview(reviews: { at: string }[]): number {
	let best = 0;
	for (const r of reviews) best = Math.max(best, new Date(r.at).getTime());
	return best;
}

const PCT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
export const pct = (x: number) => PCT.format(x);
