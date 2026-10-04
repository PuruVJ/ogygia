// The font lab's files, answered in 1.5 s (a slow font host). The bytes are not a real font — the
// browser falls back once it gives up — but it fetches them all the same, and what the devtools read
// is when each file arrived against its @font-face's font-display.
export const GET = async ({ params }) => {
	await new Promise((ok) => setTimeout(ok, 1500));
	// (/dt-font-late's two answer Vary: Origin, as a dev server does every file — in a build too)
	const varies = params.file.startsWith('late') || params.file.startsWith('early');
	return new Response(new Uint8Array(2048).fill(params.file.length), { headers: { 'content-type': 'font/woff2', 'cache-control': 'no-store', ...(varies ? { vary: 'Origin' } : {}) } });
};
