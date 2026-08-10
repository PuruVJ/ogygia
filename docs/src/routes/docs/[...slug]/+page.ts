import { error } from '@sveltejs/kit';
import { docs } from '$lib/collections';

// Validate the slug in `load` (not the component). `error(404)` thrown from a load is mapped to a
// real 404; thrown from the page component's top-level `await` it escalates to a 500 in dev. This
// guarantees a clean, styled 404 for a missing/moved page in both dev and prod.
export async function load({ params }) {
	if (!(await docs.get(params.slug ?? ''))) error(404, 'Page not found');
}
