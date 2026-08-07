import { portablePageSnippets } from '$lib/code/snippets.remote.js';
import type { PageServerLoad } from './$types';

const KEYS = ['pulse', 'ticker', 'notch'] as const;
type WidgetKey = (typeof KEYS)[number];

function isWidgetKey(value: string | null): value is WidgetKey {
	return KEYS.includes(value as WidgetKey);
}

export const load: PageServerLoad = async ({ url }) => {
	const requested = url.searchParams.get('widget');
	const active: WidgetKey = isWidgetKey(requested) ? requested : KEYS[0];
	const snippets = await portablePageSnippets();
	return { active, ...snippets };
};
