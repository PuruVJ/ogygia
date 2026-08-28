// The whole CMS as a routes-fragment — now with the signature gate: only callers holding an
// authorized private key get ANY answer. The MFE stores only PUBLIC keys (nothing to leak).
import { expose } from 'ogygia/router';
import { cms_router, BASE } from '$lib/router.js';

const pub = process.env.SHELL_PUBLIC_KEY;
export const { GET, POST, PUT, PATCH, DELETE } = expose(cms_router, {
	base: BASE,
	...(pub ? { verify: { publicKeys: [pub] } } : {})
});
