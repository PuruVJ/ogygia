/** CMS stitching DASH server-side (the three-team chain): the cms's OWN dash client — signed
 *  with the CMS'S key (dash trusts both publics), forwarding the SAME claims it received
 *  (on-behalf-of) AND continuing the trace: the trace-id that entered at the shell reaches
 *  dash two hops later. */
import { client, child_traceparent } from 'ogygia/router';

const dash = client(process.env.DASH_ORIGIN ?? 'http://localhost:5181', {
	timeout: 2000,
	...(process.env.CMS_SIGNING_KEY
		? { sign: { privateKey: process.env.CMS_SIGNING_KEY } }
		: {})
});

export async function stitch_dash_kpis(claims, incoming_traceparent) {
	try {
		const doc = await dash.widget(
			'kpis',
			{ org: 'acme' },
			{ claims, traceparent: child_traceparent(incoming_traceparent).traceparent }
		);
		// surface dash's trace id in the markup — the three-hop continuity proof reads it
		return `<div data-dash-trace="${doc.trace?.trace_id ?? ''}">${doc.html}</div>`;
	} catch {
		return '<div style="border:1px dashed #dc2626;padding:.5rem;color:#dc2626">dash unavailable</div>';
	}
}
