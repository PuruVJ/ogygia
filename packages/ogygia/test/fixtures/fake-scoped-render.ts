/**
 * A FAKE SCOPED RENDERER for the reversible-transform tests: what a web-component server render in
 * "scoped" form does to the markup ogygia hands it, reduced to its moves.
 *
 * - `<demo-card>`: its rendered tree goes into the host's light DOM, the host's children move into a
 *   `<slot>` wrapper inside it, and like a real serializer it drops whitespace-only text and trims
 *   leading / trailing whitespace to one space. It stamps its own attributes on the children
 *   (`c-id`) and the host (`class="… sc-demo-card-h"`, `data-title`), and leaves a marker comment.
 * - `<demo-link>`: its tree is an `<a>` — inside a page's own `<a>`, the HTML parser would close the
 *   outer link (the stand-in case).
 * - `<demo-skip>`: never rendered (an `og-h` host without a plan).
 *
 * On an `og-h` host it writes the plan (`og-shadow`, `og-keep`); elsewhere it renders scoped too (a
 * server-owned host the component runtime adopts later). Regex is fine here: test-only.
 */
export function fake_scoped(html: string): string {
	let out = html;
	out = render(out, 'demo-card', (inner) => {
		const trimmed = inner.replace(/>\s+</g, '><').replace(/>\s+([^<\s])/g, '> $1').replace(/([^>\s])\s+</g, '$1 <');
		const stamped = trimmed.replace(/(<[a-z][\w-]*)( og-c=")/g, '$1 c-id="0.1"$2');
		return `<div class="card sc-demo-card"><b class="sc-demo-card">Card title</b><slot class="sc-demo-card sc-demo-card-s">${stamped}</slot></div><!--o.0.1-->`;
	});
	out = render(out, 'demo-link', (inner) => `<a class="link sc-demo-link" aria-hidden="true" tabindex="-1" href="#"><slot class="sc-demo-link sc-demo-link-s">${inner}</slot></a>`);
	return out;
}

/** Rewrite every `<tag …>inner</tag>` (innermost first is enough for these fixtures: no self-nesting). */
function render(html: string, tag: string, tree: (inner: string) => string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const open = html.indexOf(`<${tag}`, at);
		if (open === -1) return out + html.slice(at);
		const gt = html.indexOf('>', open);
		const close = html.indexOf(`</${tag}>`, gt);
		const attrs = html.slice(open + tag.length + 1, gt);
		const inner = html.slice(gt + 1, close);
		const planned = / og-h="/.test(attrs);
		let host = attrs;
		if (planned) host += ` og-shadow="${tag}.shadow" og-keep="data-title"`;
		host = /\sclass="/.test(host) ? host.replace(/\sclass="([^"]*)"/, ` class="$1 sc-${tag}-h"`) : host + ` class="sc-${tag}-h"`;
		host += ' data-title="Card"';
		out += html.slice(at, open) + `<${tag}${host}>` + tree(inner) + `</${tag}>`;
		at = close + tag.length + 3;
	}
}
