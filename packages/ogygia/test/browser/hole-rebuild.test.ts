// A DEFERRED HOLE KIT RENDERS AGAIN, in a real browser. On a Kit-hydrated (csr=true) document Kit
// can give up hydrating (a component threw, the markup mismatched): Svelte clears Kit's root and
// mounts it fresh, and the wrapper's client leg renders every hole again with NO address — it
// cannot mint one. The handle recorded each hole's server-minted facts in the document tail,
// OUTSIDE Kit's root (`<script type="application/ogygia-holes">`, keyed by the hole's identity,
// `data-og-hole`); the runtime hands them back the moment the rebuilt element connects: the
// address, and a hydrating hole's props sidecar. e2e/hole-kit-rebuild runs the real thing; this
// pins the runtime half with the record + the rebuilt element alone.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import { props_sidecar_of } from '../../src/runtime/sidecar.js';

const ENDPOINT = '/__ogygia__?id=feedface0001&props=W3t9XQ&exp=9999999999&sig=stub';
const IDENTITY = 'a1b2c3d4e5f60718';
const SIDECAR = '<script type="application/ogygia-props" data-ogygia-props data-og-format="json">[{"start":1},5]</script>';

function html_response(html: string): Response {
	const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
	Object.defineProperty(res, 'url', { value: location.origin + ENDPOINT });
	return res;
}

/** The document tail as the handle emits it: after Kit's root, `<` escaped inside the JSON. */
function holes_record(record: Record<string, { endpoint: string; sidecar: string }>): string {
	return (
		'<script type="application/ogygia-holes" data-ogygia-holes>' +
		JSON.stringify(record).replaceAll('<', '\\u003C') +
		'</script>'
	);
}

test('a hole rendered again with no address gets its endpoint (and sidecar) back from the document record, and fetches', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		return html_response('<p data-testid="served">served after the rebuild</p>');
	};
	// Kit's bootstrap marks the document as Kit-hydrated; the SSR hole and the tail's record.
	document.body.innerHTML =
		'<script>__sveltekit_lab = {};</script>' +
		'<div data-kit-root>' +
		`<ogygia-region render="defer" when="load" endpoint="${ENDPOINT}" data-og-hole="${IDENTITY}"><p data-testid="fallback">fallback</p></ogygia-region>${SIDECAR}` +
		'</div>' +
		holes_record({ [IDENTITY]: { endpoint: ENDPOINT, sidecar: SIDECAR } });
	try {
		bootDev(); // the SSR element connects, fetches on load
		await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
		// Kit gives up: its root is cleared and mounted fresh — the client leg's hole has no address.
		const root = document.querySelector('[data-kit-root]') as HTMLElement;
		root.innerHTML =
			`<ogygia-region render="defer" when="load" endpoint="" data-og-hole="${IDENTITY}"><p data-testid="fallback">fallback</p></ogygia-region>`;
		const rebuilt = root.querySelector('ogygia-region')!;
		expect(rebuilt.getAttribute('endpoint'), 'the record handed the address back on connect').toBe(ENDPOINT);
		await expect.poll(() => rebuilt.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(rebuilt.querySelector('[data-testid="served"]'), 'the rebuilt hole filled from the server').not.toBeNull();
		expect(rebuilt.querySelector('[data-testid="fallback"]')).toBeNull();
		// The props sidecar came back with the address, off the DOM (Kit's tree is never edited).
		const sidecar = props_sidecar_of(rebuilt);
		expect(sidecar).not.toBeNull();
		expect(sidecar!.textContent).toBe('[{"start":1},5]');
		expect(sidecar!.getAttribute('data-og-format')).toBe('json');
		expect(root.querySelector('script'), 'no sidecar was inserted into Kit’s root').toBeNull();
	} finally {
		window.fetch = real_fetch;
	}
});

test('a hole with no address and no record keeps its fallback (nothing to fetch, no request)', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		return html_response('<p>never</p>');
	};
	document.body.innerHTML =
		'<script>__sveltekit_lab = {};</script>' +
		'<div data-kit-root><ogygia-region render="defer" when="load" endpoint="" data-og-hole="0000000000000000"><p data-testid="fallback">fallback</p></ogygia-region></div>';
	try {
		bootDev();
		await new Promise((r) => setTimeout(r, 300));
		expect(calls).toHaveLength(0);
		expect(document.querySelector('[data-testid="fallback"]')).not.toBeNull();
	} finally {
		window.fetch = real_fetch;
	}
});
