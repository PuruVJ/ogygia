import { readFile } from 'node:fs/promises';
import type { PageServerLoad } from './$types';

// Same slow I/O as /slow-io — a fake DB query (timer), a file read, and sequential upstream calls.
async function queryDatabase(ms: number): Promise<{ rows: number }> {
	await new Promise((r) => setTimeout(r, ms));
	return { rows: ms };
}
async function callService(origin: string, name: string, ms: number): Promise<unknown> {
	const res = await fetch(`${origin}/slow-io/api?name=${name}&ms=${ms}`);
	return res.json();
}
async function readManifest(): Promise<number> {
	const txt = await readFile('package.json', 'utf8');
	return txt.length;
}

// The load waits ~2.4s (timer + fetches). Then the page render burns CPU on the heavy components.
// One report, both bottlenecks: "Waiting by function" for the load, "CPU / Components" for the render.
export const load: PageServerLoad = async ({ url }) => {
	const db = await queryDatabase(1000);
	const manifestChars = await readManifest();
	const inventory = await callService(url.origin, 'inventory', 700);
	const reviews = await callService(url.origin, 'reviews', 500);
	return { db, manifestChars, feeds: [inventory, reviews] };
};
