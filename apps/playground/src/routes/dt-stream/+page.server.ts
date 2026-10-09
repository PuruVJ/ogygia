// THE STREAM LAB (devtools + profiler answer key): `reviews` is returned without awaiting, so the
// page ships its shell and the document stays open 1.2 s until it settles. Every island waits for
// the document's end — Healthy too, which reads nothing late. `?quick`: the same promise settles in
// 10 ms (the decoy: nothing held).
export const load = ({ url }) => {
	const late = url.searchParams.has('quick') ? 10 : 1200;
	return {
		title: 'stream lab',
		reviews: new Promise<string[]>((res) => setTimeout(() => res(['good', 'fine']), late))
	};
};
