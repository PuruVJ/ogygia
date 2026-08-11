import { render } from 'svelte/server';
import App from './App.svelte';

// SSR the async component. `render()` returns an awaitable; awaiting it takes the async render path
// (required for a top-level `await`), and resolves to the fully-classed `<div class="box">…</div>`.
export function ssr() {
  return render(App); // awaited by the caller
}
