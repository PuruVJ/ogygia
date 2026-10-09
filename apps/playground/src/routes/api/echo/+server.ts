import { json } from '@sveltejs/kit';
export const POST = async ({ request }) => {
	const body = await request.json();
	return json({ echoed: body, ok: true, at: new Date(0).toISOString() });
};
