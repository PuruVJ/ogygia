import { query } from '$app/server';
import { region } from 'ogygia';
import BakedChrome from './BakedChrome.svelte';

// the chrome as a held region, awaited in the page's render (async mode) — so it is BAKED into it
export const bakedChrome = query(async () => region(BakedChrome, {}));
