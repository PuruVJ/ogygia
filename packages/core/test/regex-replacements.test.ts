// Every hand-written scan that replaced a regex answers exactly what the regex did — checked against
// the original pattern over fuzzed inputs (tags, quotes, case, Unicode spaces, split markers).
import { describe, expect, it } from 'vitest';
import { region_css_links } from '../src/server/html-scan.ts';
import { escape_amp, escape_amp_quot, escape_attr, escape_text } from '../src/escape.ts';
import { is_lower_hex, is_region_id, is_region_ttl } from '../src/server/endpoint.ts';
import { dedupe_head_links } from '../src/server/head-presence.ts';
import { parse_attr_string, scanRegions } from '../src/server/split-regions.ts';

function fuzz(n: number, pieces: string[], seed = 1): string[] {
	let s = seed;
	const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		let x = '';
		const len = 1 + Math.floor(rnd() * 14);
		for (let k = 0; k < len; k++) x += pieces[Math.floor(rnd() * pieces.length)];
		out.push(x);
	}
	return out;
}

describe('regex replacements answer what the regex did', () => {
	it('region_css_links', () => {
		const re = /<link\b[^>]*data-ogygia-region-css[^>]*>/g;
		for (const h of fuzz(4000, ['<link', '<linker', '<LINK', ' rel="stylesheet"', ' data-ogygia-region-css', ' data-ogygia-region-css="/x.css"', ' href="/a.css"', '>', 'x', '<style>', '<link data-ogygia-region-css href="/b.css">']))
			expect(region_css_links(h)).toBe((h.match(re) || []).join(''));
	});

	it('escapes', () => {
		for (const v of fuzz(4000, ['&', '"', '<', '>', "'", 'a', 'ü', '/_app/x.js', '?a=1&b=2', '&amp;'])) {
			expect(escape_attr(v)).toBe(v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
			expect(escape_text(v)).toBe(v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
			expect(escape_amp_quot(v)).toBe(v.replace(/&/g, '&amp;').replace(/"/g, '&quot;'));
			expect(escape_amp(v)).toBe(v.split('&').join('&amp;'));
		}
	});

	it('capability gates', () => {
		const inputs = ['', '0', '60', '1234567', '12345678', 'abc', '9x', '0123456789ab', 'deadbeef0000', '0123456789abc', 'DEADBEEF0000', '00000000000g', 'abcdefabcdef', '１２', 'a'.repeat(64), 'f'.repeat(63) + 'g'];
		for (const s of inputs) {
			expect(is_region_id(s)).toBe(/^[0-9a-f]{12}$/.test(s));
			expect(is_region_ttl(s)).toBe(/^(|[0-9]{1,7})$/.test(s));
			expect(is_lower_hex(s, 64)).toBe(/^[0-9a-f]{64}$/.test(s));
		}
	});

	it('dedupe_head_links (regex reference)', () => {
		const ref = (head: string) => {
			if (!head.includes('<link')) return head;
			const sheets = new Set<string>();
			const hints = new Set<string>();
			return head.replace(/<link\b[^>]*>/g, (tag) => {
				const rel = /\brel=["']([^"']*)["']/.exec(tag)?.[1];
				const seen = rel === 'stylesheet' ? sheets : rel === 'modulepreload' ? hints : null;
				if (seen === null) return tag;
				const href = /\bhref=["']([^"']*)["']/.exec(tag)?.[1];
				if (href === undefined) return tag;
				if (seen.has(href)) return '';
				seen.add(href);
				return tag;
			});
		};
		const pieces = ['<link', '<LINK', '<linker', ' rel="stylesheet"', " rel='modulepreload'", ' rel=modulepreload', ' href="/a.css"', " href='/a.css'", ' href="/b.js"', ' data-rel="stylesheet"', '>', 'x', ' ', '"', "'", '<LINK rel="stylesheet" href="/a.css">', '<link rel="stylesheet" href="/a.css">', '<link rel="modulepreload" href="/b.js">'];
		for (const h of fuzz(6000, pieces)) expect(dedupe_head_links(h)).toBe(ref(h));
	});

	it('region attribute parsing (the regex rules, quirks included)', () => {
		const re = /([^\s/>=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+))?/g;
		const ref = (inner: string) => {
			const attrs: Record<string, string> = {};
			re.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(inner))) {
				let value = m[2] ?? '';
				if (value && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
				attrs[m[1].toLowerCase()] = value;
			}
			return attrs;
		};
		const pieces = [' entry="./a.js"', " wake='none'", ' endpoint=/x', ' a', '=', ' = ', '"', "'", ' b="q>w"', ' C=D', ' e=\'f', ' data-x = "y z"', '   ', ' g=/', ' h= ', ' ', 'Ü=1', '>', '/'];
		for (const inner of fuzz(6000, pieces, 7)) expect(parse_attr_string(inner)).toEqual(ref(inner));
		// and through the scan, on a well-formed tag
		const [span] = [...scanRegions('<ogygia-region entry="./a.js" WAKE=none data-x = "y z"></ogygia-region>')];
		expect(span.attrs).toEqual({ entry: './a.js', wake: 'none', 'data-x': 'y z' });
	});
});
