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

// In-memory guestbook. Resets when the server restarts and is not shared across instances — fine
// for a demo, not a database. Kept module-private: a .remote.ts file may only export remote functions.
// Ring-capped so a public docs deploy cannot grow forever (audit DOC-GB).
const entries: Entry[] = [{ name: 'Calypso', message: 'first to sign the book' }];

export const getEntries = query(async () => entries.slice(-8).reverse());

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

	entries.push({ name, message });
	while (entries.length > MAX_ENTRIES) entries.shift();
	return { ok: true, total: entries.length };
});
