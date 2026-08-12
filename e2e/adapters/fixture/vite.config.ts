import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { ogygia } from 'ogygia/vite';

// The adapter under test is chosen by env so the e2e runner never has to rewrite this file.
// `OGYGIA_E2E_ADAPTER` ∈ auto | node | static | vercel | cloudflare | netlify (default: auto).
const name = process.env.OGYGIA_E2E_ADAPTER || 'auto';
const { default: adapter } = await import(`@sveltejs/adapter-${name}`);
// Pin a Node runtime for vercel so a bleeding-edge local Node doesn't fail the adapter.
const opts = name === 'vercel' ? { runtime: 'nodejs22.x' } : {};

export default defineConfig({
	plugins: [
		ogygia(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(opts)
		})
	]
});
