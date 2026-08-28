/**
 * The shell's SSR stitch of dash's widget catalog — one `client.widget()` call. A failed MFE
 * degrades to an inline error card; the shell's page is never broken by another team.
 * (This load is a plain KIT page load — outside the router there is no `c.visitor`, so the
 * session claims are passed explicitly.)
 */
import { dash, session } from './clients.server.js';

export interface FragmentDoc {
	html: string;
	origin: string;
	failed?: boolean;
}

export async function stitch(
	name: string,
	props: Record<string, string> = {}
): Promise<FragmentDoc> {
	try {
		const doc = await dash.widget(name, props, { claims: session() });
		return { html: doc.html, origin: doc.origin ?? dash.origin };
	} catch (e) {
		return {
			html: `<div style="border:2px dashed #dc2626;border-radius:8px;padding:1rem;color:#dc2626">
				fragment <b>${name}</b> unavailable (${e instanceof Error ? e.message : e})
			</div>`,
			origin: dash.origin,
			failed: true
		};
	}
}
