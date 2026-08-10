import { parse as parseYaml } from 'yaml';

const BOM = /^\uFEFF/;
const LEADING_NEWLINE = /^\r?\n/;

export type FrontmatterResult = {
	data: Record<string, unknown>;
	body: string;
};

/**
 * Minimal `---` YAML frontmatter split. Body is unused for glob catalogs
 * (Content comes from the Vite module); data is schema-validated.
 */
export function parseFrontmatter(source: string): FrontmatterResult {
	const text = source.replace(BOM, '');
	if (!text.startsWith('---')) {
		return { data: {}, body: text };
	}
	const lineEnd = text.indexOf('\n');
	if (lineEnd === -1) return { data: {}, body: text };
	const close = text.indexOf('\n---', lineEnd);
	if (close === -1) return { data: {}, body: text };
	const yamlBlock = text.slice(lineEnd + 1, close);
	const after = text.slice(close + 4).replace(LEADING_NEWLINE, '');
	let data: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(yamlBlock);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			data = parsed as Record<string, unknown>;
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`[@ogygia/content] invalid frontmatter YAML: ${msg}`);
	}
	return { data, body: after };
}
