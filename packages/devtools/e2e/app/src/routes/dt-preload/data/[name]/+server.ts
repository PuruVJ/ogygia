// ~24 KB of JSON, never cached: a second request for it downloads it again
export function GET({ params }) {
	const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `${params.name} row ${i}`, note: 'x'.repeat(24) }));
	return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
