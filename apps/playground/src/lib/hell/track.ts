// The analytics helper every component calls on the server "so the data layer is complete": a
// payload built per call (a Date, a JSON.stringify, a hash over the string), pushed into a
// per-process array nobody drains. Called from headers, cards, buttons, facets — everywhere.
const layer: { name: string; hash: number; at: string; size: number }[] = [];
const MAX = 5000;

function buildPayload(name: string, props: Record<string, unknown>): string {
	return JSON.stringify({ event: name, at: new Date().toISOString(), page: 'hell', props, session: { id: 'anon', seq: layer.length } });
}

function hashPayload(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

export function track(name: string, props: Record<string, unknown> = {}): string {
	const payload = buildPayload(name, props);
	const hash = hashPayload(payload);
	if (layer.length < MAX) layer.push({ name, hash, at: new Date().toISOString(), size: payload.length });
	return hash.toString(16);
}

export function trackedCount(): number {
	return layer.length;
}
