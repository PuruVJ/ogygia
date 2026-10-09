<script lang="ts">
	let { post }: { post: string } = $props();
	let likes = $state(0);
</script>

<button data-testid="cms-like" onclick={() => likes++}>♥ {post}: {likes}</button>

<style>
	button { background: #7c3aed; color: white; border: 0; border-radius: 6px; padding: 0.4rem 0.9rem; cursor: pointer; }
</style>
