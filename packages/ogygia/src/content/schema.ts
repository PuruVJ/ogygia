import type { SchemaLike } from './index.js';

export async function parseSchema(schema: SchemaLike | undefined, data: unknown, label: string) {
	if (!schema) return data as Record<string, unknown>;

	if (schema['~standard']) {
		const result = await schema['~standard'].validate(data);
		if ('issues' in result && result.issues) {
			const msgs = result.issues.map((i) => i.message ?? 'invalid').join('; ');
			throw new Error(`[ogygia/content] schema failed for ${label}: ${msgs}`);
		}
		return ('value' in result ? result.value : data) as Record<string, unknown>;
	}

	if (typeof schema.parse === 'function') {
		try {
			return schema.parse(data) as Record<string, unknown>;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`[ogygia/content] schema failed for ${label}: ${msg}`);
		}
	}

	throw new Error(`[ogygia/content] schema for ${label} is not Standard Schema / parse()-compatible`);
}
