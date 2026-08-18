/**
 * API-reference rendering — ApiModule → plain markdown, so everything downstream is the ordinary
 * pipeline: heading ids + TOC, search indexing, the link audit, Shiki on every signature fence,
 * and CodeChrome's header bar. No bespoke markup, no bespoke CSS.
 */
import type { ApiExport, ApiModule } from './extract.ts';

/**
 * Make JSDoc PROSE svelte-safe: the generated markdown compiles as a Svelte template, where a stray
 * `{` is an expression. Convert `{@link X}` / `{@link X|label}` to inline code, then escape braces —
 * but never inside fenced blocks or inline code spans (mdsvex protects those already, and escaping
 * there would corrupt real code).
 */
function mdSafe(prose: string): string {
	const lines = prose.split('\n');
	let in_fence = false;
	const out = lines.map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			in_fence = !in_fence;
			return line;
		}
		if (in_fence) return line;
		// Convert `{@link X}` / `{@link X|label}` to inline code (outside fences only). All other
		// svelte-safety escaping happens at the mdast level after parsing — see expand-api's
		// svelteSafe(), which is exact where line-level regexes are not.
		return line
			.split(/(`[^`]*`)/)
			.map((seg, i) =>
				i % 2 === 1
					? seg
					: seg.replace(/\{@link\s+([^}|\s]+)(?:\s*\|\s*([^}]+))?\}/g, (_, name, label) => `\`${label ?? name}\``)
			)
			.join('');
	});
	return out.join('\n');
}

const KIND_LABEL: Record<ApiExport['kind'], string> = {
	function: 'function',
	component: 'component',
	class: 'class',
	interface: 'interface',
	type: 'type',
	const: 'const',
	other: 'export'
};

function fence(code: string): string {
	return '```ts\n' + code.trim() + '\n```';
}

function section(e: ApiExport): string {
	const parts: string[] = [];
	parts.push(`## \`${e.name}\``);
	parts.push(`<span class="api-kind api-kind--${e.kind}">${KIND_LABEL[e.kind]}</span>`);
	if (e.deprecated) parts.push(`::: warning Deprecated\n${mdSafe(e.deprecated)}\n:::`);
	if (e.doc) parts.push(mdSafe(e.doc));
	if (e.text) parts.push(fence(e.text));
	if (e.params.length) {
		parts.push(e.params.map((p) => `- \`${p.name}\` — ${mdSafe(p.doc)}`).join('\n'));
	}
	if (e.returns) parts.push(`**Returns** ${mdSafe(e.returns)}`);
	for (const ex of e.examples) {
		// House-style @example bodies are markdown already (often a caption line + a fence).
		parts.push(mdSafe(ex));
	}
	for (const m of e.members) {
		parts.push(`### \`${e.name}.${m.name}\``);
		if (m.doc) parts.push(mdSafe(m.doc));
		parts.push(fence(m.text));
	}
	return parts.join('\n\n');
}

export function renderModule(mod: ApiModule): string {
	const names = mod.exports.map((e) => `\`${e.name}\``).join(' · ');
	const head = [
		`\`\`\`ts\nimport { … } from '${mod.id}';\n\`\`\``,
		`**Exports** ${names}`
	].join('\n\n');
	return [head, ...mod.exports.map(section)].join('\n\n');
}
