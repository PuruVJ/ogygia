/**
 * THE RESTORE LAB's server transform (e2e/restore.spec.ts, `OGYGIA_RESTORE_LAB=1`): a stand-in for a
 * web-component server render in "scoped" form, reduced to what such a render does to markup.
 *
 * - `<demo-card>`: its tree goes into the host's light DOM and the host's children move into a
 *   `<slot>` wrapper inside it; like a real serializer it drops whitespace-only text and trims the
 *   rest to one space, and it stamps attributes on the children (`c-id`) and the host.
 * - `<demo-link>`: its tree is an `<a>` — inside the page's own link, the HTML parser would split it.
 *
 * On a host ogygia marks `og-h` it writes the plan (`og-shadow`, `og-keep`) and the keyed shadow sheet
 * once. Regex is fine here: a lab, not a hot path.
 */
const SHEETS: Record<string, string> = {
	'demo-card.shadow': ':host{display:block;border:2px solid #0a7;padding:8px}b.title{display:block;color:rgb(0, 119, 85)}',
	'demo-link.shadow': ':host{display:inline}a{text-decoration:underline}'
};

export function scoped_render(html: string): string {
	const used = new Set<string>();
	let out = render(html, 'demo-card', used, (inner) => {
		const trimmed = inner.replace(/>\s+</g, '><').replace(/>\s+([^<\s])/g, '> $1').replace(/([^>\s])\s+</g, '$1 <');
		const stamped = trimmed.replace(/(<[a-z][\w-]*)( og-c=")/g, '$1 c-id="0.1"$2');
		return `<div class="card sc-demo-card"><b class="title sc-demo-card">Card title</b><slot class="sc-demo-card sc-demo-card-s">${stamped}</slot></div><!--o.0.1-->`;
	});
	out = render(out, 'demo-link', used, (inner) => `<a class="link sc-demo-link" aria-hidden="true" tabindex="-1" href="#"><slot class="sc-demo-link sc-demo-link-s">${inner}</slot></a>`);
	const sheets = [...used].map((k) => `<template data-og-head="${k}">${SHEETS[k]}</template>`).join('');
	return sheets + out;
}

function render(html: string, tag: string, used: Set<string>, tree: (inner: string) => string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const open = html.indexOf(`<${tag}`, at);
		if (open === -1) return out + html.slice(at);
		const gt = html.indexOf('>', open);
		const close = html.indexOf(`</${tag}>`, gt);
		if (close === -1) return out + html.slice(at);
		let host = html.slice(open + tag.length + 1, gt);
		if (/ og-h="/.test(host)) {
			host += ` og-shadow="${tag}.shadow" og-keep="data-rendered"`;
			used.add(`${tag}.shadow`);
		}
		host = /\sclass="/.test(host) ? host.replace(/\sclass="([^"]*)"/, ` class="$1 sc-${tag}-h"`) : host + ` class="sc-${tag}-h"`;
		host += ' data-rendered=""';
		out += html.slice(at, open) + `<${tag}${host}>` + tree(html.slice(gt + 1, close)) + `</${tag}>`;
		at = close + tag.length + 3;
	}
}
