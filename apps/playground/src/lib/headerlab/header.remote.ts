import { command, getRequestEvent, query } from '$app/server';
import { region } from 'ogygia';
import DemoHeader from './DemoHeader.svelte';

// the header as a region: rendered in the page request first, in a remote request on refresh
export const headerRegion = query(async () => region(DemoHeader, {}));

// save the locale the page's load reads, then refresh the header (one single-flight response)
export const switchHeaderLocale = command('unchecked', async (locale: string) => {
	getRequestEvent().cookies.set('hl_locale', locale, { path: '/' });
	await headerRegion().refresh();
});
