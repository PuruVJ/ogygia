/**
 * The most hostile host imaginable: raw node:http, zero dependencies, no framework,
 * no build step. It mounts the ogygia CMS by printing the fragment document and the
 * MFE's own runtime script tag. GET renders; POST forwards (form actions work).
 * Run: node server.mjs   (cms on :5182, serves on :5186)
 */
import http from 'node:http';
import { createPrivateKey, createHash, sign as ed_sign } from 'node:crypto';

const PRIV = process.env.SHELL_SIGNING_KEY;
const sign_headers = (method, url, body) => {
	if (!PRIV) return {};
	const key = createPrivateKey({ key: Buffer.from(PRIV, 'base64'), format: 'der', type: 'pkcs8' });
	const ts = String(Date.now());
	const bhash = createHash('sha256').update(body ?? new Uint8Array(0)).digest('base64');
	const payload = Buffer.from(`${ts}.${method.toUpperCase()}.${url.pathname + url.search}.${bhash}.`); // trailing '.': no claims
	return { 'x-og-ts': ts, 'x-og-sig': ed_sign(null, payload, key).toString('base64') };
};

const CMS = process.env.CMS_ORIGIN ?? 'http://localhost:5182'; // vite preview binds ::1, so use localhost not 127.0.0.1
const PORT = 5186;

const page = (doc) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${doc.title || 'ACME (plain node)'}</title>
${doc.css.join('\n')}
${doc.runtime ? `<script type="module" src="${doc.runtime}"></script>` : ''}
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto}.chrome{background:#0f766e;color:#fff;padding:.6rem 1rem;border-radius:8px}</style>
</head><body>
<nav class="chrome"><strong>Zero-dependency node:http host</strong> — everything below is the ogygia CMS</nav>
${doc.body}
</body></html>`;

const fail = `<!doctype html><body style="font-family:system-ui"><div style="border:2px dashed #dc2626;padding:1rem;color:#dc2626">CMS unreachable — the rest of this host is unaffected.</div></body>`;

http.createServer(async (req, res) => {
	const u = new URL(req.url, `http://localhost:${PORT}`);
	// links/forms inside the fragment are authored in the CMS's OWN base space (/cms/...) —
	// strip the base before forwarding, since expose() re-prepends it.
	let path = u.searchParams.get('p') ?? u.pathname;
	if (path.startsWith('/cms')) path = path.slice(4) || '/';
	const target = new URL('/og/fragment/page', CMS);
	target.searchParams.set('path', path);
	try {
		const init = { method: req.method, signal: AbortSignal.timeout(3000) };
		if (req.method === 'POST') {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			init.body = Buffer.concat(chunks);
			init.headers = { 'content-type': req.headers['content-type'] ?? 'application/x-www-form-urlencoded', origin: CMS };
		}
		init.headers = { ...init.headers, ...sign_headers(req.method, target, init.body) };
		const doc = await (await fetch(target, init)).json();
		if (doc.location) {
			res.writeHead(req.method === 'POST' ? 303 : doc.status, { location: doc.location });
			return res.end();
		}
		res.writeHead(doc.status, { 'content-type': 'text/html' });
		res.end(page(doc));
	} catch {
		res.writeHead(503, { 'content-type': 'text/html' });
		res.end(fail);
	}
}).listen(PORT, () => console.log(`plain host on http://localhost:${PORT}`));
