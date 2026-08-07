import { query, form } from '$app/server';
import { invalid } from '@sveltejs/kit';

// A remote `form()` used inside an island, plus a `query` that reads the guestbook back. Validation
// is done by hand (no schema library): the `'unchecked'` overload hands us the raw input plus an
// `issue` helper we use to mark fields invalid. Enhanced submit, per-field issues, pending state,
// and the no-JS fallback all come from Kit's own form runtime (reused by ogygia inside islands).

type Entry = { name: string; message: string };

const MAX_NAME = 64;
const MAX_MESSAGE = 280;
const MAX_ENTRIES = 48;

// In-memory guestbook on `globalThis` so Vite duplicate-module loads (SSR page graph vs remote
// endpoint) still share one store within a process. Resets when the isolate restarts — not a
// database, and not shared across serverless instances.
type GuestbookStore = { entries: Entry[] };
const g = globalThis as typeof globalThis & { __ogygia_docs_guestbook__?: GuestbookStore };
if (!g.__ogygia_docs_guestbook__) {
	g.__ogygia_docs_guestbook__ = {
		entries: [{ name: 'Calypso', message: 'first to sign the book' }]
	};
}
const store = g.__ogygia_docs_guestbook__;

export const getEntries = query(async () => store.entries.slice(-8).reverse());

export const signGuestbook = form('unchecked', async (data: Record<string, unknown>, issue) => {
	const name = typeof data.name === 'string' ? data.name.trim() : '';
	const message = typeof data.message === 'string' ? data.message.trim() : '';

	if (!name && !message) {
		invalid(issue.name('name is required'), issue.message('message is required'));
	}
	if (!name) invalid(issue.name('name is required'));
	if (!message) invalid(issue.message('message is required'));
	if (name.length > MAX_NAME) invalid(issue.name(`name must be ≤${MAX_NAME} characters`));
	if (message.length > MAX_MESSAGE) invalid(issue.message(`message must be ≤${MAX_MESSAGE} characters`));

	store.entries.push({ name, message });
	while (store.entries.length > MAX_ENTRIES) store.entries.shift();
	return { ok: true, total: store.entries.length };
});
