/**
 * HMAC-SHA256 for region capability URLs — Node `createHmac` (sync).
 *
 * Used by `ogygiaHandle` and by SSR `virtual:ogygia/sign`. The client never imports this
 * module: ServerIsland goes through `virtual:ogygia/sign`, which is a no-op on the client
 * (secret is already empty there). Web Crypto is not used — browsers must not mint with a
 * real secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class Hmac {
	static sha256(key: string, message: string): string {
		return createHmac('sha256', key).update(message, 'utf8').digest('hex');
	}

	static sign(secret: string, message: string): string {
		return Hmac.sha256(secret, message);
	}

	static verify(secret: string, message: string, sig: string): boolean {
		if (typeof sig !== 'string' || sig.length !== 64) return false;
		const expected = Hmac.sha256(secret, message);
		try {
			return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
		} catch {
			return false;
		}
	}

	/**
	 * MAC message for a signed region capability. Empty `session` keeps the 3-field form
	 * (prerender / unbound); a non-empty session appends a fourth field.
	 */
	static region_message(
		id: string,
		exp: number | string,
		props: string,
		session = ''
	): string {
		return session ? `${id}\0${exp}\0${props}\0${session}` : `${id}\0${exp}\0${props}`;
	}
}

export const hmacSha256 = Hmac.sha256.bind(Hmac);
export const sign = Hmac.sign.bind(Hmac);
export const verify = Hmac.verify.bind(Hmac);
export const region_mac_message = Hmac.region_message.bind(Hmac);
