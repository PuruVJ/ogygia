// The shelf island's data, read through a helper: the island's own file never touches page.data,
// so the line to fix is here, where the build's seed report says it is.
import { page } from '$app/state';

export function shelfOf(): { id: string; name: string; price: number }[] {
	// PATTERN seed-whole-read: page.data taken whole into a local, so the build cannot pin a key and every key ships in the seed
	const all = page.data;
	return (all.shelf ?? []) as { id: string; name: string; price: number }[];
}
