// What Kit's generated client entry does on a csr=true document (KIT_PAGE_THREAD in vite/index.ts):
// publish Kit's real `page` on the well-known symbol. A Kit-document test that expects an island of
// ours (inside a lake, inside a hole's answer) to wake must publish it too — the runtime waits for it.
const KIT_PAGE_KEY = Symbol.for('ogygia.kit-page');

export function publish_kit_page(data: Record<string, unknown> = {}): void {
	(globalThis as unknown as Record<symbol, unknown>)[KIT_PAGE_KEY] = {
		page: {
			url: new URL(location.href),
			params: {},
			route: { id: '/kit' },
			status: 200,
			data,
			form: null,
			error: null,
			state: {}
		},
		navigating: { current: null }
	};
}

export function unpublish_kit_page(): void {
	delete (globalThis as unknown as Record<symbol, unknown>)[KIT_PAGE_KEY];
}
