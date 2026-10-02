// The font lab's files, answered in 1.5 s (a slow font host). The bytes are not a real font — the
// browser falls back once it gives up — but it fetches them all the same, and what the devtools read
// is when each file arrived against its @font-face's font-display.
export const GET = async ({ params }) => {
	await new Promise((ok) => setTimeout(ok, 1500));
	return new Response(new Uint8Array(2048).fill(params.file.length), { headers: { 'content-type': 'font/woff2', 'cache-control': 'no-store' } });
};
