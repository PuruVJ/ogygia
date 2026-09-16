<script lang="ts">
	// A tiny island whose scoped CSS is under the playground's `kit.inlineStyleThreshold`, so its
	// sheet ships INLINE (`<style data-ogygia-region-css="…">`) instead of as a blocking `<link>` —
	// e2e/inline-css.spec.ts.
	let n = $state(0);
</script>

<button class="inline-css" data-inline-css onclick={() => n++}>inline:{n}</button>

<style>
	.inline-css {
		letter-spacing: 3px;
		border: 2px solid rgb(17, 34, 51);
	}
</style>
