// Stub for Kit's `#app/state/client` inside its remote-functions client (it reads `page.url`,
// `navigating?.to?.url`). No router — never navigating; good enough for request context.
export const page = {
	get url() {
		return typeof location !== 'undefined' ? new URL(location.href) : new URL('http://localhost/');
	}
};
export const navigating = { to: null };
/** A remote response's app version, for Kit's update check — no Kit client here to update. */
export function notify_version(_version: string): void {}
