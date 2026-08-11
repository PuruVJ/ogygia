import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Minimal Vite SSR dev server: assets go through Vite middleware; `/` is server-rendered.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

createHttpServer((req, res) => {
  if (req.url !== '/') return vite.middlewares(req, res);
  vite.middlewares(req, res, async () => {
    try {
      const template = await vite.transformIndexHtml('/', readFileSync('index.html', 'utf-8'));
      const { ssr } = await vite.ssrLoadModule('/src/entry-server.js');
      const { head, body } = await ssr();
      const html = template.replace('<!--ssr-head-->', head).replace('<!--ssr-body-->', body);
      res.setHeader('content-type', 'text/html').end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      res.statusCode = 500;
      res.end(e.stack);
    }
  });
}).listen(5199, () => console.log('repro → http://localhost:5199'));
