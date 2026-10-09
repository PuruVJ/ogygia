import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [ogygia(), sveltekit()],
	// cors: the SHELL page (another origin) dynamic-imports this app's island chunks.
	// In production this is one header on the CDN; for the POC, vite preview's cors flag.
	preview: { cors: true },
	server: { cors: true }
});
