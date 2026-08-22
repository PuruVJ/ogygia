// The browser host's vendored md5 + sha256 must match node:crypto EXACTLY (they address the caches +
// region ids the Vite plugin also writes — a mismatch would split-brain warm builds vs the REPL).
// Run: `node browser-host.test.mjs`.
import { createHash as nodeCreateHash } from 'node:crypto';
import { createHash } from './browser-host.ts';

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

const nodeHex = (algo, s) => nodeCreateHash(algo).update(s, 'utf8').digest('hex');
const ourHex = (algo, s) => createHash(algo).update(s).digest('hex');

console.log('browser-host hashes vs node:crypto\n');

// Fixed vectors across boundaries: empty, 1 byte, exactly one block (55/56/64/119/120 bytes stress the
// padding path), multibyte utf8, and the low ascii range.
const fixed = [
	'',
	'a',
	'abc',
	'message digest',
	'The quick brown fox jumps over the lazy dog',
	'a'.repeat(55),
	'a'.repeat(56),
	'a'.repeat(63),
	'a'.repeat(64),
	'a'.repeat(65),
	'a'.repeat(119),
	'a'.repeat(120),
	'a'.repeat(1000),
	'héllo wörld — ünïcödé ✨🏝️',
	'{@const}\n#each\n<script>\n:::tip',
	'\0\0\0boundary\0nulls'
];
for (const algo of ['md5', 'sha256']) {
	let all = true;
	let firstBad = '';
	for (const s of fixed) {
		if (ourHex(algo, s) !== nodeHex(algo, s)) { all = false; firstBad = JSON.stringify(s.slice(0, 30)); break; }
	}
	ok(`${algo}: ${fixed.length} fixed vectors match node:crypto`, all, firstBad && `first mismatch at ${firstBad}`);
}

// Fuzz: random-length random-byte strings.
function randStr(n) {
	let s = '';
	for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(Math.random() * 0x2fff) + 1);
	return s;
}
for (const algo of ['md5', 'sha256']) {
	let all = true;
	let bad = '';
	for (let i = 0; i < 500; i++) {
		const s = randStr(Math.floor(Math.random() * 300));
		if (ourHex(algo, s) !== nodeHex(algo, s)) { all = false; bad = JSON.stringify(s.slice(0, 20)); break; }
	}
	ok(`${algo}: 500 random fuzz strings match node:crypto`, all, bad && `mismatch: ${bad}`);
}

// Chained update() must equal the concatenation.
{
	const chained = createHash('sha256').update('foo').update('bar').update('baz').digest('hex');
	ok('chained update() == single update of concatenation', chained === nodeHex('sha256', 'foobarbaz'));
}

console.log(`\n${'─'.repeat(44)}`);
console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
