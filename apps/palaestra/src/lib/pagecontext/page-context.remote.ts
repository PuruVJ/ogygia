import { command, getRequestEvent, query } from '$app/server';
import { region } from 'ogygia';
import RemoteFacts from './RemoteFacts.svelte';

// rendered in the page request at first, in a remote request on refresh
export const pageFacts = query(async () => await region(RemoteFacts, {}));

// a setting the page's load reads (the locale) changes, and the region comes back re-rendered
export const switchLocale = command('unchecked', async (locale: string) => {
	getRequestEvent().cookies.set('pc_locale', locale, { path: '/' });
	return await region(RemoteFacts, {});
});
