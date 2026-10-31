// PLANTED render-blocking stylesheet: answered in 2.4 s, so the page's first paint waits for it. The
// devtools must name it as the part of the first paint that cost most. (A route name only: it is CSS.)
export const GET = async () => {
	await new Promise((ok) => setTimeout(ok, 2400));
	return new Response('h1.dt-fcp { color: #264; }\n', { headers: { 'content-type': 'text/css', 'cache-control': 'no-store' } });
};
