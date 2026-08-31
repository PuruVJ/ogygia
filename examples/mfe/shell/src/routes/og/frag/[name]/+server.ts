/**
 * The lazy client-stitch endpoint: the browser fetches THE SHELL for fragment JSON — never an
 * MFE server (no CORS, no exposed internal hosts, one cookie domain). `proxy()` splits the
 * `<app>:<name>` param and forwards through the named app's client — its signing, timeout,
 * and failure card come from the client's own policy. A dead MFE answers `{ failed: true }`,
 * which the hole renders as its failed card; the page never breaks.
 */
import { proxy } from 'ogygia/router';
import { dash, session } from '$lib/clients.server.js';

// `widgets` allowlists the names the browser may reach — without it this is an open proxy to
// any `/og/fragment/*` on dash. `user` signs the shell's OWN session onto each hop; the widget
// authorizes what it returns against those claims, never against the browser-chosen props.
export const { GET } = proxy({ dash }, { user: () => session(), widgets: { dash: ['kpis'] } });
