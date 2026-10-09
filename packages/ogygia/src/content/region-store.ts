/**
 * The REGION STORE — the CONTENT pillar's persistent home for SERIALIZED REGIONS. Node-only.
 *
 * It lives in content deliberately: a region is storable exactly when its input is DATA (markdown
 * text, block JSON, any compiled format) — and input-is-data is what defines the content pillar.
 * Pure-runtime regions (inline component awaits, server islands, lakes) render components + live
 * state: no content address exists for them, and freshness is their point — they are NOT producers.
 *
 * A serialized region is the framework's one content currency: `{ html }` today, growing island
 * descriptors (and hover payloads, etc.) WITH the region contract — never a bespoke per-producer
 * format. Every producer harnesses the same store with its own namespace:
 *
 *   - `new RegionStore('fences')` — the fence pipeline (one region per rendered code block)
 *   - `new RegionStore('docs')`   — the markdown region emitter (one region per document)
 *   - future: CMS block bakes, on-demand publishes, incremental-build inputs, edge push
 *
 * Addressing is content-hashing over producer-supplied parts (`store.key([...])`) — no invalidation
 * logic anywhere: changed input = different address, stale entries sit until pruned. Persistence
 * rides the shared {@link BuildCache} (`node_modules/.ogygia/<namespace>/`), so build platforms that
 * cache `node_modules` keep every baked region across builds.
 */
// createHash via the compiler HOST SEAM (defaults to Node; a browser installs a JS sha impl) so the
// content/markdown pipeline runs in the Observatory REPL with no node:crypto. Vite plugin unchanged.
import { createHash } from '../compiler/host.js';
import { BuildCache } from '../build-cache.js';

/** A region in its serialized form — what crosses caches, wires, and builds. `html` is the whole
 *  baked markup; `islands` is reserved for descriptor-carrying regions (the wake list). */
export type SerializedRegion = {
	html: string;
	islands?: Array<Record<string, unknown>>;
};

export class RegionStore {
	readonly #cache: BuildCache<SerializedRegion>;
	readonly #version: string;

	/** `namespace` is the store's directory inside the shared cache; `version` bumps every address
	 *  when the producer's OUTPUT SHAPE changes without any input changing (rare). */
	constructor(namespace: string, version = '1') {
		this.#cache = new BuildCache<SerializedRegion>(namespace);
		this.#version = version;
	}

	/** A stable address from the parts that shape a region's content. */
	key(parts: ReadonlyArray<string>): string {
		const h = createHash('sha256');
		h.update(this.#version);
		for (const p of parts) {
			h.update('\0');
			h.update(p);
		}
		return h.digest('hex').slice(0, 40);
	}

	get(key: string): SerializedRegion | null {
		return this.#cache.get(key);
	}

	set(key: string, region: SerializedRegion): void {
		this.#cache.set(key, region);
	}
}
