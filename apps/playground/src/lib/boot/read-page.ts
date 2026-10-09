// A plain module that reads the page through `$app/state`, imported by BOTH worlds: the csr=true
// /kit page (Kit's real page) and an island on a csr=false page (the seeded shim). It is reached
// only through an app ALIAS (`$boot/read-page`), the import shape the eager island-closure walk
// used to stop at — leaving this module's `$app/state` to whichever world resolved it first. On a
// customer's dev server the account page (Kit) came first, and the same helper then read
// `page.data.user` as empty inside an island on every public page. e2e/shared-page-module.spec.ts.
import { page } from '$app/state';

export function page_name(): string {
	return String((page.data as { name?: string }).name ?? '');
}
