// Minimal PROD SSR server: serves the built client bundle (hashed JS + BLOCKING <link> CSS) and
// server-renders `/` from the SSR bundle. Mirrors the real deploy: scoped CSS is a render-blocking
// stylesheet in <head>, so `.panel { position: fixed }` is applied at first paint — isolating whether
// the class-attribute empties during PROD async hydration (the confound-free reproduction).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('./dist/', import.meta.url);
const template = readFileSync(new URL('index.html', DIST), 'utf-8');
const { ssr } = await import(new URL('./dist-server/entry-server.js', import.meta.url).href);

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.map': 'application/json' };

createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  // static asset from dist/
  const filePath = join(new URL(DIST).pathname, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (url !== '/' && existsSync(filePath) && statSync(filePath).isFile()) {
    res.setHeader('content-type', MIME[extname(filePath)] || 'application/octet-stream');
    res.end(readFileSync(filePath));
    return;
  }
  try {
    const { head, body } = await ssr();
    const html = template.replace('<!--ssr-head-->', head).replace('<!--ssr-body-->', body);
    res.setHeader('content-type', 'text/html').end(html);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e && e.stack ? e.stack : e));
  }
}).listen(5200, () => console.log('prod repro → http://localhost:5200'));
