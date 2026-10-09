<script lang="ts">
	// THE RESTORE LAB's island: a component host whose children the scoped render moves into its tree
	// (with the whitespace it trims), a block the tree opens inside this island's <p>, and the tree's
	// link inside this island's link. After the restore it must hydrate as is: no heal, and the
	// button counts.
	let n = $state(0);
</script>

<demo-card class="own" data-lab-card>
	<button data-lab-count onclick={() => n++}>count {n}</button>
	some   text
</demo-card>
<p data-lab-p>Buy <demo-card data-lab-inline>now</demo-card></p>
<a href="/restore-lab#card" data-lab-link><demo-link>Go</demo-link></a>
