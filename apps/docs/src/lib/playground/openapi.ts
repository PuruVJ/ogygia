/**
 * `openapi()` — a hand-written content SOURCE over an OpenAPI 3 spec. One spec file fans out into an
 * entry per operation (path × method), grouped by tag for a 2-level nav (tag → operation). `$ref`s are
 * resolved against the spec's components (cycle-guarded, keeping each named schema's title for
 * cross-linking), so an operation page has everything it needs inline.
 *
 * This is the DOCUMENTED escape hatch, not a macro: a loader macro (`import.meta.og.loader.*`) returns
 * a FINISHED source and isn't meant to be wrapped, so a bespoke shape like this reads the raw
 * `import.meta.glob` itself and builds a source with `defineSource`. Exactly how `markdown()`/`json()`
 * are made — one level up, for a spec instead of a file.
 */
import { defineSource, titleCase, type GlobMap, type GroupMeta, type RawSource } from 'ogygia/content';

// ── the shapes an operation entry carries (all structured DATA; the page renders it) ──

export type OASchema = Record<string, unknown> & {
	/** The named component this schema came from (`Pet`), when it was a `$ref` — for cross-links. */
	name?: string;
};
export type OAParam = { name: string; in: string; required: boolean; description?: string; schema?: OASchema };
export type OABody = { required: boolean; description?: string; mediaType: string; schema?: OASchema } | null;
export type OAResponse = { status: string; description?: string; mediaType?: string; schema?: OASchema };
export type OASecurity = { scheme: string; scopes: string[] };

export type Operation = {
	method: string;
	path: string;
	operationId: string;
	tag: string;
	summary: string;
	description: string;
	parameters: OAParam[];
	requestBody: OABody;
	responses: OAResponse[];
	security: OASecurity[];
};

// ── spec plumbing ──

type Spec = {
	info?: { title?: string; version?: string; description?: string };
	tags?: Array<{ name: string; description?: string }>;
	paths?: Record<string, Record<string, RawOp>>;
	components?: { schemas?: Record<string, OASchema>; securitySchemes?: Record<string, unknown> };
};
type RawOp = {
	tags?: string[];
	summary?: string;
	description?: string;
	operationId?: string;
	parameters?: Array<Record<string, unknown>>;
	requestBody?: Record<string, unknown>;
	responses?: Record<string, Record<string, unknown>>;
	security?: Array<Record<string, string[]>>;
};

/** Canonical method order for listing an operation set. */
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** Resolve a `#/…` JSON pointer against the spec root. */
function pointer(spec: Spec, ref: string): unknown {
	if (!ref.startsWith('#/')) return undefined;
	let node: unknown = spec;
	for (const seg of ref.slice(2).split('/')) {
		node = (node as Record<string, unknown> | undefined)?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
	}
	return node;
}

/** Deep-resolve `$ref`s in a schema. Cycle-guarded (a schema that refers to itself resolves once,
 *  then leaves a shallow `{ name }` marker), and every named `$ref` keeps its component name so the
 *  UI can cross-link to the schema. */
function deref(spec: Spec, node: unknown, seen: Set<string>): OASchema | undefined {
	if (!node || typeof node !== 'object') return node as undefined;
	const obj = node as Record<string, unknown>;
	if (typeof obj.$ref === 'string') {
		const ref = obj.$ref;
		const name = ref.split('/').pop();
		if (seen.has(ref)) return { name, $circular: true } as OASchema; // stop a cycle
		const target = pointer(spec, ref);
		const resolved = deref(spec, target, new Set(seen).add(ref)) ?? {};
		return { ...resolved, name };
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (Array.isArray(v)) out[k] = v.map((x) => deref(spec, x, seen));
		else if (v && typeof v === 'object') out[k] = deref(spec, v, seen);
		else out[k] = v;
	}
	return out as OASchema;
}

/** The first media type's schema from a `content` map (we render JSON first). */
function pick_content(spec: Spec, content: unknown): { mediaType: string; schema?: OASchema } | null {
	if (!content || typeof content !== 'object') return null;
	const entries = Object.entries(content as Record<string, { schema?: unknown }>);
	const chosen = entries.find(([m]) => m.includes('json')) ?? entries[0];
	if (!chosen) return null;
	return { mediaType: chosen[0], schema: deref(spec, chosen[1]?.schema, new Set()) };
}

/** One raw operation → the structured entry the page renders. */
function to_operation(spec: Spec, method: string, path: string, raw: RawOp): Operation {
	const tag = raw.tags?.[0] ?? 'default';
	const operationId = raw.operationId ?? `${method}${path.replace(/[^a-z0-9]+/gi, '-')}`;
	const parameters: OAParam[] = (raw.parameters ?? []).map((p) => ({
		name: String(p.name ?? ''),
		in: String(p.in ?? 'query'),
		required: !!p.required,
		description: p.description as string | undefined,
		schema: deref(spec, p.schema, new Set())
	}));
	let requestBody: OABody = null;
	if (raw.requestBody) {
		const c = pick_content(spec, (raw.requestBody as { content?: unknown }).content);
		requestBody = {
			required: !!(raw.requestBody as { required?: boolean }).required,
			description: (raw.requestBody as { description?: string }).description,
			mediaType: c?.mediaType ?? 'application/json',
			schema: c?.schema
		};
	}
	const responses: OAResponse[] = Object.entries(raw.responses ?? {}).map(([status, r]) => {
		const c = pick_content(spec, (r as { content?: unknown }).content);
		return { status, description: (r as { description?: string }).description, mediaType: c?.mediaType, schema: c?.schema };
	});
	const security: OASecurity[] = (raw.security ?? []).flatMap((s) =>
		Object.entries(s).map(([scheme, scopes]) => ({ scheme, scopes }))
	);
	return { method, path, operationId, tag, summary: raw.summary ?? operationId, description: raw.description ?? '', parameters, requestBody, responses, security };
}

/** Flatten every spec in the glob into an ordered operation list + the tag groups. */
function collect(specs: Spec[]): { ops: Array<{ id: string; op: Operation; order: number[] }>; groups: Map<string, GroupMeta> } {
	const groups = new Map<string, GroupMeta>();
	const tag_index = new Map<string, number>();
	const ops: Array<{ id: string; op: Operation; order: number[] }> = [];

	for (const spec of specs) {
		// Tag order: declared `tags` first (with their descriptions), then any tag first seen on an op.
		for (const t of spec.tags ?? []) {
			if (!tag_index.has(t.name)) {
				tag_index.set(t.name, tag_index.size);
				groups.set(t.name, { label: t.description || titleCase(t.name) });
			}
		}
		const flat: Operation[] = [];
		for (const [path, methods] of Object.entries(spec.paths ?? {})) {
			for (const method of METHOD_ORDER) {
				if (methods[method]) flat.push(to_operation(spec, method, path, methods[method]!));
			}
		}
		// Stable per-tag order: keep the order operations appear in the spec.
		const per_tag = new Map<string, number>();
		for (const op of flat) {
			if (!tag_index.has(op.tag)) {
				tag_index.set(op.tag, tag_index.size);
				groups.set(op.tag, { label: titleCase(op.tag) });
			}
			const oi = per_tag.get(op.tag) ?? 0;
			per_tag.set(op.tag, oi + 1);
			ops.push({ id: `${op.tag}/${op.operationId}`, op, order: [tag_index.get(op.tag)!, oi] });
		}
	}
	return { ops, groups };
}

/**
 * Build a content source from a glob of OpenAPI 3 JSON specs. Point a `content()` collection at it and
 * every operation is an entry (`data` is the {@link Operation}), grouped by tag.
 *
 *   export const petstore = content({ loader: openapi(import.meta.glob('../content/openapi/*.json', { eager: true, import: 'default' })) });
 */
export function openapi(globMap: GlobMap) {
	const specs = Object.values(globMap).map((m) => (typeof m === 'function' ? undefined : (m as Spec))).filter(Boolean) as Spec[];
	const { ops, groups } = collect(specs);
	const by_id = new Map(ops.map((o) => [o.id, o]));

	const raw: RawSource<Operation> = {
		async get(id) {
			const hit = by_id.get(id);
			return hit ? { id, value: hit.op, order: hit.order } : null;
		},
		async refs() {
			return ops.map((o) => ({ id: o.id, value: o.op, order: o.order }));
		},
		async groups() {
			return groups;
		}
	};

	// The whole operation is the entry's `data`; `title` (the nav/chrome label) is the summary.
	return defineSource<Operation, { method: string; tag: string }>(raw, (op) => ({
		data: { ...op, title: op.summary || op.operationId } as unknown as Record<string, unknown>,
		meta: { method: op.method, tag: op.tag }
	}));
}
