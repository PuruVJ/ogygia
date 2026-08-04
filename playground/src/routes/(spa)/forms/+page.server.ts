import { fail, redirect } from '@sveltejs/kit';
import { addEntry, listEntries } from '$lib/server/guestbook';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({
	entries: listEntries(),
	ok: url.searchParams.get('ok') === '1'
});

export const actions: Actions = {
	// Classic Kit form action: native <form method="POST"> submission, no JS required.
	add: async ({ request }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const message = String(data.get('message') ?? '').trim();
		if (!name || !message) {
			// re-render the page (200) with the validation error + entered values
			return fail(400, { error: 'name and message are required', name, message });
		}
		addEntry(name, message);
		// post-redirect-get: 303 -> GET /forms?ok=1
		redirect(303, '/forms?ok=1');
	}
};
