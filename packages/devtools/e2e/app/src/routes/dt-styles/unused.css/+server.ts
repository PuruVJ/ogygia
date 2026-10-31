// 600 rules for markup this page never has: the "match nothing" half of the styles answer key.
let css = '';
for (let i = 0; i < 600; i++) css += `.lab-unused-${i} { color: #334155; padding: ${i % 24}px 12px; margin: 0 0 8px; border: 1px solid #cbd5e1; }\n`;

export const GET = () => new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60' } });
