/**
 * Serve one demo app's adapter-node build WITH the cross-origin header its assets need:
 * a foreign island's chunk is loaded by ANOTHER origin's page via dynamic import(), which is a
 * CORS request — without `Access-Control-Allow-Origin` the browser refuses it ("Failed to fetch
 * dynamically imported module") and the island degrades. In production this header lives on the
 * MFE's CDN/proxy for its immutable assets; this wrapper is the demo's stand-in.
 *
 *     node serve.mjs dash 5181
 */
import { createServer } from 'node:http';

const [, , app, port] = process.argv;
if (!app || !port) {
	console.error('usage: node serve.mjs <app> <port>');
	process.exit(1);
}
const { handler } = await import(`./${app}/build/handler.js`);

createServer((req, res) => {
	// the assets other origins import: island/runtime chunks + their CSS under the immutable dir
	if (req.url?.includes('/_app/immutable/')) {
		res.setHeader('access-control-allow-origin', '*');
	}
	handler(req, res, () => {
		res.statusCode = 404;
		res.end('not found');
	});
}).listen(Number(port), () => {
	console.log(`${app} on :${port} (with asset CORS)`);
});
