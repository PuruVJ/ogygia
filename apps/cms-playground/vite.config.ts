import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// The CMS playground has NO local markdown — every entry comes over HTTP from the fake CMS API
// (see src/routes/api). The ogygia plugin is still needed for islands (`with { region, wake }`).
export default defineConfig({
	resolve: { dedupe: ['@sveltejs/kit'] },
	plugins: [ogygia(), sveltekit()]
});
