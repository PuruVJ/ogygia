<script lang="ts">
	// A STATIC result — no interactivity, so it ships HTML only (partial: 'static').
	let { query } = $props<{ query: string }>();
</script>

<p class="pkg-empty">No package matches <strong>“{query}”</strong>. Try <em>svelte</em>, <em>kit</em>, or <em>vite</em>.</p>

<style>
	.pkg-empty { margin: 0; padding: 1rem 1.1rem; border: 1px dashed var(--doc-border, #3a3a3a); border-radius: 12px; opacity: 0.8; }
</style>
