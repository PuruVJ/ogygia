<script lang="ts">
	let { text }: { text: string } = $props();
</script>

<p class="blk-prose">{text}</p>

<style>
	.blk-prose {
		margin: 0 0 1rem;
		line-height: 1.65;
	}
</style>
