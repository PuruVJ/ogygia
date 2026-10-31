/**
 * THE region signing key, decided once at first use (the first mint or verify), not at module eval:
 * a host that fills `process.env` after the server's modules load (an adapter loading a `.env` late)
 * still counts. The runtime's `OGYGIA_SECRET` wins; else this build's random key.
 *
 * A capability carries its minter's key FINGERPRINT (`&k=`): an HMAC of a constant under the key —
 * the same on every instance sharing the key, and it reveals nothing of the key. A deployment that
 * verifies a capability minted under another key can then say so (`x-ogygia-deny: foreign-key`)
 * instead of an opaque 403: the page and its islands endpoint came from different deployments (a CDN
 * routing them to two backends, HTML cached across a key change).
 */
import { buildKey, buildHadSecret } from 'virtual:ogygia/secret';
import { sign } from 'virtual:ogygia/sign';
import { building } from '$app/env';

export interface SigningKey {
	secret: string;
	/** env-provided: survives redeploys and is shared by every deployment that sets the same value */
	stable: boolean;
	/** 8-char key fingerprint (`&k=` on capabilities, `x-ogygia-key` on refusals) */
	fp: string;
}

let key: SigningKey | undefined;

export function signing_key(): SigningKey {
	if (key) return key;
	const from_env = (typeof process !== 'undefined' && process.env?.OGYGIA_SECRET) || '';
	const secret = from_env || buildKey;
	key = { secret, stable: from_env !== '', fp: key_fingerprint(secret) };
	if (!key.stable && !import.meta.env.DEV) warn_build_key();
	return key;
}

export function key_fingerprint(secret: string): string {
	return sign(secret, 'ogygia:key-fp').slice(0, 8);
}

/** One message per process (a shared Symbol: one across every copy of this module): a server
 *  signing with this build's random key. */
function warn_build_key(): void {
	const g = globalThis as Record<symbol, unknown>;
	const K = Symbol.for('ogygia.build-key-warned');
	if (g[K]) return;
	g[K] = true;
	if (building) {
		console.warn(
			'[ogygia] prerendered page mints region capabilities signed with a per-build random key — they stop verifying after your next deploy while the static HTML lives on. Set a stable OGYGIA_SECRET env var so prerendered holes survive redeploys.'
		);
	} else if (buildHadSecret) {
		console.error(
			"[ogygia] OGYGIA_SECRET was set when this app was built but is not set where it runs: region capabilities are signed with this build's random key, so every hole minted by another deployment (another backend behind the same CDN, the previous deploy) is refused (403, x-ogygia-deny: foreign-key). Set OGYGIA_SECRET in the server's runtime environment."
		);
	} else {
		console.warn(
			"[ogygia] OGYGIA_SECRET is not set: region capabilities are signed with this build's random key, so a page cached across a deploy, or served by another deployment than its islands endpoint, gets its holes refused (403, x-ogygia-deny: foreign-key). Set a stable OGYGIA_SECRET."
		);
	}
}

/** Tests: forget the decided key. */
export function reset_signing_key(): void {
	key = undefined;
}
