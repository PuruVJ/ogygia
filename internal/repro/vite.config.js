import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [
    svelte({
      // Top-level `await` in a component requires the async compiler feature.
      compilerOptions: { experimental: { async: true } }
    })
  ]
});
