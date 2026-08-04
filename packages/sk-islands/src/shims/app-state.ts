// Client-side shim for `$app/state` used INSIDE islands.
//
// Under `csr = false`, Kit's client runtime never boots, so the real
// `$app/state` `page` would be uninitialised on the client. The runtime seeds a
// per-page snapshot on `window.__skIslandsPage` (reconstructed from each island's
// SSR snapshot) BEFORE hydrating. These getters read that global.
//
// Backing this with a global (rather than a module singleton) makes it robust to
// the shim being duplicated across the runtime chunk and island chunks. Islands
// unmount/remount on SPA navigation, so a fresh island always reads the fresh
// snapshot — page values stay correct without cross-chunk reactivity.
//
// Aliased only in the CLIENT build; SSR keeps the real `$app/state`.

const FALLBACK = {
	url: typeof location !== 'undefined' ? new URL(location.href) : new URL('http://localhost/'),
	params: {},
	route: { id: null },
	status: 200,
	data: {},
	form: null,
	error: null,
	state: {}
};

function snap() {
	return (typeof window !== 'undefined' && window.__skIslandsPage) || FALLBACK;
}

export const page = {
	get url() {
		return snap().url;
	},
	get params() {
		return snap().params;
	},
	get route() {
		return snap().route;
	},
	get status() {
		return snap().status;
	},
	get data() {
		return snap().data;
	},
	get form() {
		return snap().form ?? null;
	},
	get error() {
		return snap().error ?? null;
	},
	get state() {
		return snap().state ?? {};
	}
};

export const navigating = {
	get current() {
		return null;
	}
};
export const updated = {
	get current() {
		return false;
	},
	check: async () => false
};
