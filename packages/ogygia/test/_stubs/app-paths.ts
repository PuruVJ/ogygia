// Test stub for Kit's `$app/paths`, for an app at the root: `asset()` takes a path without its leading
// slash (Kit warns on one with it) and answers it root-absolute; `resolve()` reads a leading slash as a
// route id and none as a pathname.
export const asset = (file: string) => {
	if (file.startsWith('/')) throw new Error(`asset() takes a path without its leading slash (got "${file}").`);
	return '/' + file;
};
export const resolve = (id: string) => (id.startsWith('/') ? id : '/' + id);
