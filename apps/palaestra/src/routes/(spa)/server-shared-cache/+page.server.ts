// A page its load marks shared-cacheable for 8 days (a week fresh + a day of revalidation): a CDN
// serves this document long after `regions.ttl`, so its deferred hole must be signed for the
// document's cache life (e2e/cached-document-holes.spec.ts).
export function load({ setHeaders }) {
	setHeaders({ 'cache-control': 'public, s-maxage=604800, stale-while-revalidate=86400' });
}
