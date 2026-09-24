// A plain HTML document that is NOT an ogygia page (a `+server` response carries no router marker):
// the stand-in for another application's page behind the same origin (e2e/router-document-fetch).
export const GET = () =>
	new Response('<!doctype html><title>elsewhere</title><h1 data-elsewhere>another application</h1>', {
		headers: { 'content-type': 'text/html' }
	});
