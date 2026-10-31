// The uncompressed lab's data: ~30 KB of JSON the page fetches after load, answered with
// `Content-Encoding: identity` (compression left off), like the script beside it.
const body = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, title: `entry ${i}`, note: 'a note repeated on every entry' })));

export const GET = () => new Response(body, { headers: { 'content-type': 'application/json', 'content-encoding': 'identity' } });
