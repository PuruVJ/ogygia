import { form } from '$app/server';
import * as v from 'valibot';
import { addEntry, listEntries } from './server/guestbook';

// A SvelteKit remote `form` used inside an island. Reused straight from Kit (ogygia loads Kit's
// own client form runtime) — schema validation -> field issues, enhanced submit, and pending
// state all work; no-JS submits post to the remote endpoint and post-redirect-get back.
export const signGuestbook = form(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(1, 'name is required'), v.maxLength(64)),
		message: v.pipe(
			v.string(),
			v.trim(),
			v.minLength(1, 'message is required'),
			v.maxLength(280)
		)
	}),
	async ({ name, message }) => {
		addEntry(name, message);
		return { ok: true, total: listEntries().length };
	}
);
