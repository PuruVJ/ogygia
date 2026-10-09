// The THIRD-PARTY answer key page: its "third parties" are served by this same app under the OTHER
// loopback name (127.0.0.1 ↔ localhost) — another origin to the browser, no network needed.
export const csr = false;
export const prerender = false;

export function load({ url }) {
	const other = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
	return { third: `${url.protocol}//${other}:${url.port}/dt-third/s` };
}
