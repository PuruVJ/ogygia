// The background-hero lab's stylesheet: answered in 2.6 s (an LCP past 2.5 s is explained), and the
// only place the hero image is named — the browser cannot ask for the image before it has this file
// and has laid the page out. (The image is the image lab's noisy PNG: a flat one, an SVG of a few
// shapes, is too little detail per pixel for the browser to count as the largest paint.)
export const GET = async () => {
	await new Promise((ok) => setTimeout(ok, 2600));
	return new Response('.dt-lcp-bg-hero { width: 1000px; height: 480px; background: url(/dt-img/right.png) center / cover no-repeat; }\n', {
		headers: { 'content-type': 'text/css', 'cache-control': 'no-store' }
	});
};
