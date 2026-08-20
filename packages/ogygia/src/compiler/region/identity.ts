/**
 * Region identity — the JOIN KEY of the whole compiler. Two files that mark the same component the
 * same way independently mint the SAME id, and the linker collapses them; that is why a blind,
 * file-local front-end and a dumb cross-file reducer stay decoupled. Pure functions, no state.
 *
 *   strategyKey    — a mark's dedupe fingerprint (schedule + the options baked into the wrapper)
 *   regionIdentity — posix component path ⊕ strategyKey (cross-host stable identity)
 *   regionId       — hash(identity, optional prod salt) → the 12-char content-hashed id
 */
import { createHash } from 'node:crypto';

const PATH_SEP = /[/\\]/;

/**
 * Fingerprint of a region mark for dedupe. Same component path + same key → one wrapper/entry.
 * @param {{ strategy: string, options?: Record<string, unknown> }} mark
 */
export function strategyKey(mark: { strategy: string; options?: Record<string, unknown> | null }) {
	const o = mark.options || {};
	if (mark.strategy === 'server') {
		let k = `defer:${o.when ?? 'load'}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		// Cache TTL is baked into the wrapper (it signs the endpoint), so it MUST fingerprint the
		// wrapper — else a cached hole (maxAge) dedupes onto a plain no-store wrapper of the same
		// component+schedule and silently loses its `ttl`.
		if (o.cacheTtlSec != null) k += `:ttl:${o.cacheTtlSec}`;
		if (o.hydrate) {
			k += `+hydrate:${o.hydrate}`;
			if (o.hydrateMargin != null) k += `:hmargin:${o.hydrateMargin}`;
		}
		return k;
	}
	if (mark.strategy === 'lake') {
		let k = `lake:${o.remount || 'cache'}`;
		if (o.when) k += `:when:${o.when}`;
		if (o.maxAgeMs != null) k += `:maxAge:${o.maxAgeMs}`;
		if (o.onExpire) k += `:onExpire:${o.onExpire}`;
		if (o.margin != null) k += `:margin:${o.margin}`;
		return k;
	}
	// A held region (a marked import handed to `region()`, not placed) is a server-chosen island minted
	// on demand. Its baked wake schedule IS part of the key (`region:visible` ≠ `region:raw`), and the
	// `region:` prefix keeps it distinct from a PLACED wrapper of the same component+schedule
	// (`hydrate:visible`), so a component both placed and held gets two artifacts, not a collision. It
	// always ships a client chunk (it MIGHT be woken; `region:raw` bakes no schedule → set at the call).
	if (mark.strategy === 'held') {
		let k = `region:${o.hydrate || 'raw'}`;
		if (o.hydrateMargin != null) k += `:hmargin:${o.hydrateMargin}`;
		return k;
	}
	let k = `hydrate:${mark.strategy}`;
	if (o.margin != null) k += `:margin:${o.margin}`;
	// `keep` (continuity name) is baked into the wrapper (`__keep=…`), so it MUST split the wrapper —
	// two same-component+schedule imports with different keep names need distinct wrappers, else the
	// second inherits the first's relocation slot (like `margin`, above).
	if (o.keep != null) k += `:keep:${o.keep}`;
	return k;
}

/**
 * Cross-host stable identity: posix component path + {@link strategyKey}.
 * Drives region ids so multiple hosts / import sites / `<A />` usages share one module.
 */
export function regionIdentity(
	componentRelPath: string,
	mark: { strategy: string; options?: Record<string, unknown> | null }
) {
	return `${String(componentRelPath).split(PATH_SEP).join('/')}\0${strategyKey(mark)}`;
}

/** Hash an identity string (optional production salt) → 12-char region id. */
export function regionId(identityKey: string, salt = '') {
	const msg = salt ? `${salt}\0${identityKey}` : identityKey;
	return createHash('md5').update(msg).digest('hex').slice(0, 12);
}
