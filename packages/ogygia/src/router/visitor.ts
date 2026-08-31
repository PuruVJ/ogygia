/**
 * Anonymous visitor identity — sticky experiments/flags/rollouts for LOGGED-OUT traffic.
 * Without an identity, splits degrade to control (nothing to hash on); this resolver mints a
 * random id into a cookie on first sight and returns it as `{ sub }` forever after, so a
 * rollout percentage holds for anonymous visitors too.
 *
 *     routes(table, { visitor: anonymousVisitor() })                      // anonymous-only
 *     routes(table, { visitor: (c) => session(c) ?? anon(c) })            // session first
 *
 * The id is random (not a fingerprint), first-party, and carries nothing — rotate it by
 * clearing the cookie. GDPR-wise it is a functional identifier; consult your own counsel.
 */
import { randomUUID } from 'node:crypto';
import type { Ctx, Visitor } from './ctx.js';

export interface AnonymousVisitorOptions {
	/** Cookie name (default `og-vid` — the same one experiment()'s fallback chain reads). */
	cookie?: string;
	/** Cookie lifetime in days (default 365). */
	days?: number;
}

export function anonymousVisitor(
	opts: AnonymousVisitorOptions = {}
): (c: Ctx) => Visitor | undefined {
	const name = opts.cookie ?? 'og-vid';
	const max_age = (opts.days ?? 365) * 86_400;
	return (c) => {
		const existing = c.cookies?.get(name);
		if (existing) return { sub: existing, anonymous: true };
		const id = randomUUID();
		// mounted in Kit → its cookie jar (adds the header AND makes the value readable this
		// request); standalone → a set-cookie on the router-built response via setHeaders
		if (c.cookies?.set) {
			c.cookies.set(name, id, {
				path: '/',
				maxAge: max_age,
				httpOnly: true,
				sameSite: 'lax'
			});
		} else {
			c.setHeaders?.({
				'set-cookie': `${name}=${id}; Path=/; Max-Age=${max_age}; HttpOnly; SameSite=Lax`
			});
		}
		return { sub: id, anonymous: true };
	};
}
