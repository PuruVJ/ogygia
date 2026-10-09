// What Kit's generated client entry does on a csr=true document (KIT_PAGE_THREAD in vite/index.ts):
// publish a LIVE reference to Kit's `$app/state` page on the well-known symbol. Faithful to Kit's own
// shape (client/state.svelte.js): every field is a `$state.raw`, the page is constructed with
// `status = -1` and `start()`'s `initialize()` assigns the real status + data. An island of ours on a
// Kit document waits for THAT assignment (kit-page-thread.svelte.ts), observed by an effect — so the
// helper's fields must be reactive, exactly like Kit's. No `$page` store anywhere (gone in Kit 3).
const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');

type Data = Record<string, unknown>;

class KitPage {
	data = $state.raw<Data>({});
	form = $state.raw<unknown>(null);
	error = $state.raw<unknown>(null);
	params = $state.raw<Record<string, string>>({});
	route = $state.raw<{ id: string | null }>({ id: null });
	state = $state.raw<Record<string, unknown>>({});
	status = $state.raw(-1);
	url = $state.raw(new URL('a:'));
}

function publish(page: KitPage): void {
	(globalThis as unknown as Record<symbol, unknown>)[KIT_PAGE_KEY] = {
		page,
		navigating: { current: null },
		navigation: {}
	};
}

/** Kit's `initialize()`: the server page lands on the live object in one assignment. */
function apply(page: KitPage, data: Data): void {
	Object.assign(page, { url: new URL(location.href), route: { id: '/kit' }, status: 200, data });
}

/** A Kit page whose `start()` has run: the bridge is up AND its page is applied. */
export function publish_kit_page(data: Data = {}): void {
	const page = new KitPage();
	apply(page, data);
	publish(page);
}

/**
 * The field window: Kit's entry has evaluated (the bridge is up, holding the live page) but `start()`
 * has NOT applied the page yet — `status` is still -1, `data` is `{}`. `settle(data)` is `initialize()`
 * landing the server page.
 */
export function publish_kit_page_deferred(): { settle(data: Data): void } {
	const page = new KitPage();
	publish(page);
	return {
		settle(data) {
			apply(page, data);
		}
	};
}

export function unpublish_kit_page(): void {
	delete (globalThis as unknown as Record<symbol, unknown>)[KIT_PAGE_KEY];
}
