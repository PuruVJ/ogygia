import type { LayoutServerLoad } from './$types';

// The OG image lives at `<origin>/og`, and that origin must be THIS deployment's — a preview build
// pointing og:image at the production domain 404s (prod has no /og until the branch merges). Vercel
// exposes the origin in build + runtime env: production → the canonical domain; preview → the stable
// branch URL (or the immutable deploy URL). Falls back to the canonical for local builds. Read from
// `process.env` directly ($env/dynamic/private is disallowed while prerendering, $env/static/private
// errors when the var is absent locally).
const CANONICAL = 'https://ogygia.puruvj.dev';

function og_origin(): string {
	const env = process.env;
	if (env.VERCEL_ENV === 'production') return CANONICAL;
	if (env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;
	if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
	return CANONICAL;
}

export const load: LayoutServerLoad = () => ({ ogOrigin: og_origin() });
