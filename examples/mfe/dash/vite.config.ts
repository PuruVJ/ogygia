import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { flags } from '@ogygia/flags/vite';
import { federation } from '@ogygia/federation/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [ogygia({ plugins: [flags(), federation()] }), sveltekit()],
	// cors: the SHELL page (another origin) dynamic-imports this app's island chunks.
	// In production this is one header on the CDN; for the POC, vite preview's cors flag.
	preview: { cors: true },
	server: { cors: true }
});
