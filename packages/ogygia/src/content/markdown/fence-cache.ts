/**
 * Content-addressed fence cache — the fence pipeline HARNESSING ogygia's core {@link RegionStore}
 * (`fences` namespace): each rendered code block persists as a serialized region across dev restarts
 * and builds. Shiki + the variant generators (the TS compiler, twoslash) dominate a cold corpus
 * compile; their output is a pure function of the fence + config, so it's identical work every
 * restart. A fence's region has no islands today — when one grows a live preview island or a hover
 * payload, the shape grows WITH the region contract, no format fork.
 *
 * Addressing is the store's content-hashing over every input that shapes the output (ogygia
 * version, theme/lang config, pipeline signature, lang, infostring, source) — NO invalidation
 * logic: a changed input is a different address, stale entries just sit until pruned.
 */
import { __set_build_cache_root } from '../../build-cache.js';
import { RegionStore, type SerializedRegion } from '../region-store.js';

/** @deprecated Old name — a fence's cached form IS a {@link SerializedRegion}. */
export type FenceRegion = SerializedRegion;

/** Bump when the renderer's OUTPUT SHAPE changes without any input changing (rare). */
const store = new RegionStore('fences', '1');

/** Test hook: point the whole build cache at a directory (or `null` to disable, `undefined` to
 *  re-probe). Kept under the old name for the existing tests. */
export function __set_fence_cache_dir(d: string | null | undefined): void {
	__set_build_cache_root(d);
}

/** A stable address from the parts that shape a fence's output. */
export function fence_key(parts: ReadonlyArray<string>): string {
	return store.key(parts);
}

export function fence_cache_get(key: string): SerializedRegion | null {
	return store.get(key);
}

export function fence_cache_set(key: string, region: SerializedRegion): void {
	store.set(key, region);
}
