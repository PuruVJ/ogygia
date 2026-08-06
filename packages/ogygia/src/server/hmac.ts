/**
 * HMAC-SHA256 for region capability URLs — Node `createHmac` (sync).
 *
 * Used by `ogygiaHandle` and by SSR `virtual:ogygia/sign`. The client never imports this
 * module: ServerIsland goes through `virtual:ogygia/sign`, which is a no-op on the client
 * (secret is already empty there). Web Crypto is not used — browsers must not mint with a
 * real secret.
 *
 * MAC format is versioned (`v1|…`) with UTF-8 length-prefixed fields so `\0` inside a
 * field cannot shift boundaries. Signing keys are HKDF-derived (`ogygia-mac-v1`) from the
 * raw secret so the id-salt domain stays separate.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const MAC_INFO = Buffer.from('ogygia-mac-v1');
const ID_SALT_INFO = Buffer.from('ogygia-id-salt-v1');
const utf8 = new TextEncoder();

/** Minimum UTF-8 byte length for a user-supplied `OGYGIA_SECRET` in production builds. */
export const MIN_SECRET_BYTES = 16;

/** HKDF-SHA256 → 32-byte MAC key (hex for stable logging / tests; Buffer used internally). */
export function derive_mac_key(secret: string): Buffer {
	return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), MAC_INFO, 32));
}

/** HKDF-SHA256 → 16-byte id salt (hex). Empty input must not be used — caller gates on env. */
export function derive_id_salt(secret: string): string {
	return Buffer.from(
		hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), ID_SALT_INFO, 16)
	).toString('hex');
}

/** True when a configured secret meets the production entropy floor. */
export function secret_has_min_entropy(secret: string): boolean {
	return Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES;
}

/** UTF-8 length-prefix so field contents cannot forge delimiters. */
function lp(s: string): string {
	return `${utf8.encode(s).byteLength}:${s}`;
}

export class Hmac {
	static sha256(key: Buffer, message: string): string {
		return createHmac('sha256', key).update(message, 'utf8').digest('hex');
	}

	static sign(secret: string, message: string): string {
		return Hmac.sha256(derive_mac_key(secret), message);
	}

	static verify(secret: string, message: string, sig: string): boolean {
		// Reject non-hex / wrong length before Buffer work (L-HMAC charset precheck).
		if (typeof sig !== 'string' || !HEX64.test(sig)) return false;
		const expected = Hmac.sha256(derive_mac_key(secret), message);
		try {
			return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
		} catch {
			return false;
		}
	}

	/**
	 * MAC message for a signed region capability (`v1`, always four length-prefixed fields).
	 * Empty `session` is still a field (prerender / unbound) — never optional concat.
	 */
	static region_message(
		id: string,
		exp: number | string,
		props: string,
		session = ''
	): string {
		return `v1|${lp(String(id))}|${lp(String(exp))}|${lp(String(props))}|${lp(String(session))}`;
	}
}

export const hmacSha256 = (secret: string, message: string) => Hmac.sign(secret, message);
export const sign = Hmac.sign.bind(Hmac);
export const verify = Hmac.verify.bind(Hmac);
export const region_mac_message = Hmac.region_message.bind(Hmac);
