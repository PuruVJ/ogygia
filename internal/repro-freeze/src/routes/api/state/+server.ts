import { json } from '@sveltejs/kit';
import { render_counts } from '$lib/server/state.js';

/** Harness introspection: the per-route REAL render counters. (JSON — never storable.) */
export function GET() {
	return json({ renders: render_counts() });
}
