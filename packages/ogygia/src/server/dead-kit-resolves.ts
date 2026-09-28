/**
 * Drop Kit's streamed resolve scripts from a document with no Kit client (csr=false). A load that
 * returns promises makes Kit stream `<script>__sveltekit_x.resolve(…)</script>` chunks after the
 * document; they call a global only Kit's client bootstrap defines, so on a csr=false page each one
 * throws. (When an island reads the page, `stream_page_deferred` replaces the whole tail instead.)
 *
 * Only a chunk that STARTS with `<script` is decoded and looked at — the document and every other
 * chunk (late regions included) pass untouched: no copy, no scan of a big page.
 */
const SCRIPT_BYTES = [60, 115, 99, 114, 105, 112, 116]; // "<script"

export function drop_dead_kit_resolves(response: Response): Response {
	const body = response.body;
	if (!body) return response;
	const decoder = new TextDecoder();
	const out = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				let starts = chunk.length >= SCRIPT_BYTES.length;
				for (let i = 0; starts && i < SCRIPT_BYTES.length; i++) if (chunk[i] !== SCRIPT_BYTES[i]) starts = false;
				if (starts && chunk.length < 1 << 20) {
					const text = decoder.decode(chunk);
					if (text.includes('__sveltekit_') && text.includes('.resolve(')) return; // dead here
				}
				controller.enqueue(chunk);
			}
		})
	);
	return new Response(out, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
}
