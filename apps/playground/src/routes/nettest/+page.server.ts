export const csr = false;
export const load = async ({ url }) => {
	// An EXTERNAL POST → definitely a real globalThis.fetch, so the profiler's net patch captures it
	// with its request payload + sizes. httpbin echoes the body back.
	// `?big=N` posts an N-thousand-row array (~a few MB) to exercise the streaming/lazy payload viewer.
	const big = Number(url.searchParams.get('big')) || 0;
	const body = big
		? JSON.stringify({
				note: `synthetic ${big}k-row payload — the report formats + highlights this only when expanded`,
				rows: Array.from({ length: big * 1000 }, (_, i) => ({
					id: i,
					sku: `SKU-${(i * 7919).toString(36)}`,
					qty: (i % 13) + 1,
					price: Math.round((i % 1000) * 3.5),
					tags: ['alpha', 'beta', i % 2 ? 'odd' : 'even']
				}))
			})
		: JSON.stringify({
				user: { id: 42, name: 'Ada Lovelace', roles: ['admin', 'author'] },
				items: [1, 2, 3, 4, 5],
				nested: { deep: { value: true, note: 'formatted JSON, 600px tall, expand-only' } }
			});
	try {
		const res = await fetch('https://httpbin.org/post', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
		return { data: await res.json() };
	} catch (e) {
		return { data: { error: String(e) } };
	}
};
