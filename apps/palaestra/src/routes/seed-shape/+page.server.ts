// SEED SHAPING fixture: a load that returns far more than the page's island reads — the shape of a
// CMS page whose load carries the header entry, page content, dictionaries… for the SERVER render,
// while one island reads a single key. `big` must never reach the page seed on /seed-shape.
export const load = () => ({
	small: 'hello-shaped',
	big: 'B'.repeat(300_000),
	nested: { deep: { value: 42 } }
});
