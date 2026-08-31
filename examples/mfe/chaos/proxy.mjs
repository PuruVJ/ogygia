// Chaos proxy: sits between the shell and the cms (:5187 → :5182). Injects latency/failures,
// counts upstream calls. Control: /__chaos?delay=<ms>&fail=<0..1>  Stats: /__chaos/stats  Reset: /__chaos/reset
import http from 'node:http';

const UP = 'http://localhost:5182';
let delay = 0, fail = 0, upstream = 0;

http.createServer(async (req, res) => {
	const u = new URL(req.url, 'http://x');
	if (u.pathname === '/__chaos') {
		delay = Number(u.searchParams.get('delay') ?? delay);
		fail = Number(u.searchParams.get('fail') ?? fail);
		res.end(JSON.stringify({ delay, fail })); return;
	}
	if (u.pathname === '/__chaos/stats') { res.end(JSON.stringify({ upstream, delay, fail })); return; }
	if (u.pathname === '/__chaos/reset') { upstream = 0; res.end('{}'); return; }

	upstream++;
	if (Math.random() < fail) { res.writeHead(500); res.end('chaos'); return; }
	if (delay) await new Promise((r) => setTimeout(r, delay));
	try {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		// real reverse-proxy behavior: the origin header must match what the upstream believes
		// its own origin is, or Kit's CSRF gate 403s form POSTs (found by the mutation test)
		const headers = { ...req.headers };
		if (headers.origin) headers.origin = UP;
		const r = await fetch(UP + req.url, {
			method: req.method,
			headers,
			body: chunks.length ? Buffer.concat(chunks) : undefined,
			redirect: 'manual'
		});
		// undici already DECOMPRESSED the body — forwarding the upstream's content-encoding /
		// content-length verbatim poisons the downstream decoder ("incorrect header check").
		const out = Object.fromEntries(r.headers);
		delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
		res.writeHead(r.status, out);
		res.end(Buffer.from(await r.arrayBuffer()));
	} catch (e) {
		res.writeHead(502); res.end(String(e));
	}
}).listen(5187, () => console.log('chaos proxy on :5187 → :5182'));
