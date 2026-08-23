// Unit tests for the Observatory share-link codec (src/lib/repl/hash.ts). The decode path takes
// UNTRUSTED URL input, so the adversarial cases matter as much as the happy round-trip. Run in Node —
// every browser global the codec uses (btoa/atob, TextEncoder, CompressionStream, Blob, Response)
// exists there, and Node strips the .ts types natively.
import { encode_hash, decode_hash, sanitize_files, b64url_encode, b64url_decode } from './hash.ts';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};
const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('hash codec\n');

// ── round-trip ──
{
	const ws = { files: { 'App.svelte': '<h1>hi</h1>', 'src/lib/x.ts': 'export const a = 1;' }, active: 'App.svelte', tab: 'preview', mode: 'live', cursor: 42 };
	const h = await encode_hash(ws);
	ok('encode returns a #-prefixed opaque string (no visible params)', h.startsWith('#') && !/[=&]/.test(h.slice(1)) && !h.includes('code=') && !h.includes('files='), h.slice(0, 24));
	const back = await decode_hash(h);
	ok('round-trips files + ui state', back && back.files['App.svelte'] === ws.files['App.svelte'] && back.files['src/lib/x.ts'] === ws.files['src/lib/x.ts'] && back.active === 'App.svelte' && back.tab === 'preview' && back.mode === 'live' && back.cursor === 42, JSON.stringify(back));
}

// ── unicode survives the byte<->base64 path ──
{
	const ws = { files: { 'u.svelte': '<h1>\u{1F3DD}️ café 你好 ​ zwsp</h1>' }, active: 'u.svelte' };
	const back = await decode_hash(await encode_hash(ws));
	ok('unicode / emoji / zero-width survive the round-trip', back && back.files['u.svelte'] === ws.files['u.svelte'], JSON.stringify(back?.files));
}

// ── uncompressed fallback (no gzip magic) is auto-detected ──
{
	const back = await decode_hash('#' + b64url({ f: { 'Good.svelte': '<h1>ok</h1>' }, a: 'Good.svelte' }));
	ok('reads an uncompressed base64url payload (no gzip magic)', back && back.files['Good.svelte'] === '<h1>ok</h1>' && back.active === 'Good.svelte');
}

// ── legacy bare-map shape (very old links) ──
{
	const back = await decode_hash('#' + b64url({ 'App.svelte': '<h1>legacy</h1>' }));
	ok('reads the legacy bare file-map shape', back && back.files['App.svelte'] === '<h1>legacy</h1>');
}

// ── legacy `files=` uri-encoded links ──
{
	const back = await decode_hash('#files=' + encodeURIComponent(JSON.stringify({ 'App.svelte': '<h1>f</h1>' })));
	ok('reads a legacy files= uri-encoded link', back && back.files['App.svelte'] === '<h1>f</h1>');
}

// ── sanitizer: untrusted input ──
{
	ok('sanitize drops non-string values', JSON.stringify(sanitize_files({ a: 'x', b: 42, c: { nested: true }, d: null, e: [1] })) === JSON.stringify({ a: 'x' }));
	ok('sanitize drops empty / whitespace keys', JSON.stringify(sanitize_files({ '': 'x', '  ': 'y', ok: 'z' })) === JSON.stringify({ ok: 'z' }));
	ok('sanitize returns {} for non-objects', JSON.stringify(sanitize_files(null)) === '{}' && JSON.stringify(sanitize_files('str')) === '{}' && JSON.stringify(sanitize_files(7)) === '{}');
	const many = {};
	for (let i = 0; i < 1000; i++) many['f' + i] = 'x';
	ok('sanitize caps the file count (<=400)', Object.keys(sanitize_files(many)).length === 400);
	const big = { a: 'x'.repeat(5_000_000), b: 'kept-nope' };
	const capped = sanitize_files(big);
	ok('sanitize caps total size (drops overflow)', capped.b === undefined);
}

// ── a crafted link with a non-string file is sanitized, not trusted ──
{
	const back = await decode_hash('#' + b64url({ f: { 'Bad.svelte': 42, 'Good.svelte': '<h1>ok</h1>' }, a: 'Good.svelte' }));
	ok('crafted link: non-string file dropped, good file kept', back && back.files['Good.svelte'] === '<h1>ok</h1>' && !('Bad.svelte' in back.files), JSON.stringify(back?.files));
}

// ── a link that sanitizes to empty → null (caller falls back to demo) ──
{
	ok('all-invalid file map decodes to null', (await decode_hash('#' + b64url({ f: { x: 1, y: {} } }))) === null);
	ok('empty object decodes to null', (await decode_hash('#' + b64url({}))) === null);
}

// ── malformed / hostile strings never throw, return null ──
{
	const junk = ['#', '#@@@not-base64@@@', '#' + Buffer.from('not json at all', 'utf8').toString('base64'), '#code=zzzz-not-gzip', '#files=%ZZbad', '#' + b64url([1, 2, 3])];
	let survived = true;
	for (const j of junk) { try { if ((await decode_hash(j)) !== null) survived = false; } catch { survived = false; } }
	ok('malformed / hostile hashes never throw, decode to null', survived);
}

// ── empty / no hash ──
{
	ok('empty hash → null', (await decode_hash('')) === null && (await decode_hash('#')) === null);
}

// ── b64url helpers round-trip arbitrary bytes ──
{
	const bytes = new Uint8Array([0, 1, 2, 250, 255, 62, 63, 43, 47, 128]);
	const back = b64url_decode(b64url_encode(bytes));
	ok('b64url_encode/decode round-trips raw bytes', back.length === bytes.length && bytes.every((b, i) => back[i] === b));
}

console.log(`\n${'─'.repeat(44)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
