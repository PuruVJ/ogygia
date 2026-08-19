import { readFile } from 'node:fs/promises';
import type { PageServerLoad } from './$types';

// A slow DB query, simulated as a socket wait. Pure waiting, no HTTP, no CPU — the exact thing a
// CPU profiler can't see. The `setTimeout` is inline here so its async-hooks caller reads as
// `queryDatabase`, and the profiler's "Waiting by function" table blames it by name.
async function queryDatabase(ms: number): Promise<{ rows: number }> {
	await new Promise((r) => setTimeout(r, ms));
	return { rows: ms };
}

// A slow upstream call. Uses global fetch so the profiler's network patch attributes it here.
async function callService(origin: string, name: string, ms: number): Promise<unknown> {
	const res = await fetch(`${origin}/slow-io/api?name=${name}&ms=${ms}`);
	return res.json();
}

// A file read, so the "file" I/O kind shows up too.
async function readManifest(): Promise<number> {
	const txt = await readFile('package.json', 'utf8');
	return txt.length;
}

// Everything awaited ONE AFTER ANOTHER on purpose — the classic slow page. ~3.5s of pure waiting,
// almost no CPU. The profiler should show: budget bar mostly idle, and "Waiting by function"
// naming queryDatabase (timer), callService (http), readManifest (file).
export const load: PageServerLoad = async ({ url }) => {
	const db = await queryDatabase(1500);
	const manifestChars = await readManifest();
	const inventory = await callService(url.origin, 'inventory', 700);
	const pricing = await callService(url.origin, 'pricing', 600);
	const reviews = await callService(url.origin, 'reviews', 500);
	return { db, manifestChars, feeds: [inventory, pricing, reviews] };
};
