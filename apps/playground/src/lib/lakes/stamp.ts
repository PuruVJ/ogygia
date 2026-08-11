// Server-side render counter. A frozen region's HTML is produced twice: once during page SSR and
// again by the signed region endpoint on a `render: 'live'` revalidate. A monotonic counter makes
// the two distinguishable, so the lakes suite can prove SWR painted FRESH html (not the cache).
let renders = 0;

export function next_stamp(): number {
	return ++renders;
}
