// Test stub for Kit's `$app/paths` — Kit 2's (the repo's own Kit): an asset path or a pathname takes
// its leading slash, and one without is refused, as Kit 2's `resolve` refuses it.
const refuse_relative = (p: string) => {
	if (!p.startsWith('/')) throw new Error(`Cannot use \`resolve(...)\` with a non-absolute pathname or route ID (got "${p}").`);
	return p;
};
export const asset = refuse_relative;
export const base = '';
export const assets = '';
export const resolve = refuse_relative;
