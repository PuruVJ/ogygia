// The uncompressed lab's script: ~120 KB of plain JavaScript (a long table of rows, the way a
// vendored library or a generated config looks), answered with `Content-Encoding: identity` (a
// server's compression skips a response that already names its encoding), so it stays as it is. The browser reports it came down as large as it decodes.
const rows = Array.from({ length: 1500 }, (_, i) => `\t{ id: ${i}, name: 'row ${i}', label: 'the label of row number ${i}', on: ${i % 2 === 0} }`);
const body = `window.__dt_raw_rows = [\n${rows.join(',\n')}\n];\n`;

export const GET = () => new Response(body, { headers: { 'content-type': 'text/javascript', 'content-encoding': 'identity' } });
