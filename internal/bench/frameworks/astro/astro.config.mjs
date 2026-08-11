import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import preact from '@astrojs/preact';

export default defineConfig({
	integrations: [mdx(), preact()],
	trailingSlash: 'never'
});
